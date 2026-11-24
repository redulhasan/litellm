import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DashboardMode from "./DashboardMode";
import { controlPlaneSessionKey } from "@/lib/http/controlPlane";

const configPath = "/litellm/.well-known/litellm-ui-config";
const prefix = "/équipe–ops+qa/v1";
const plane = (id: string, name: string) => ({
  id,
  name,
  source: "config",
  credentials: ["service_token"],
  url: `http://${id}.invalid`,
});

function mockApi({
  scopes,
  bindings,
  rootPath = "",
  disabled = false,
  conflictingRoleSave = () => Response.json({ detail: "Role is managed by configuration." }, { status: 409 }),
}: {
  scopes: string[];
  bindings: string[] | null;
  rootPath?: string;
  disabled?: boolean;
  conflictingRoleSave?: () => Response | Promise<Response>;
}) {
  const responses = new Map<string, unknown>([
    [
      configPath,
      {
        mode: "control_plane_api",
        control_plane_api_prefix: prefix,
        server_root_path: rootPath,
        admin_ui_disabled: disabled,
      },
    ],
    [`${prefix}/auth/login`, { access_token: "control-session", token_type: "bearer", expires_in: 900 }],
    [
      `${prefix}/auth/me`,
      { subject: "operator", email: null, roles: ["test"], scopes, dataplanes: bindings, token_kind: "ui" },
    ],
    [`${prefix}/dataplanes`, { items: [plane("east", "East"), plane("west", "West")] }],
    [`${prefix}/dataplanes/east/health`, { status: "ok" }],
    [`${prefix}/dataplanes/west/health`, { status: "unreachable" }],
    [
      `${prefix}/dataplanes/east/proxy/organization/list`,
      [{ organization_id: "org-1", organization_alias: "East organization" }],
    ],
    [
      `${prefix}/dataplanes/east/proxy/v1/model/info`,
      {
        data: [
          {
            model_name: "East model",
            model_info: { id: "model-1", db_model: true },
            litellm_params: { model: "openai/existing", headers: { Authorization: "REDACTED" }, rpm: 20 },
          },
        ],
      },
    ],
    [`${prefix}/dataplanes/east/proxy/model/model-1/update`, {}],
    [
      `${prefix}/dataplanes/east/proxy/guardrails/list`,
      { guardrails: [{ guardrail_id: "config-1", guardrail_name: "Configured guardrail" }] },
    ],
    [
      `${prefix}/dataplanes/east/proxy/v2/guardrails/list`,
      {
        guardrails: [
          { guardrail_id: "config-1", guardrail_name: "Configured guardrail", guardrail_definition_location: "config" },
          { guardrail_id: "db-1", guardrail_name: "Saved guardrail", guardrail_definition_location: "db" },
        ],
      },
    ],
    [`${prefix}/roles`, { items: [] }],
    [
      `${prefix}/fleet/models`,
      {
        partial: true,
        unreachable: [{ id: "west", reason: "connection refused" }],
        items: [{ model_name: "east-model", dataplane_id: "east", provider: "openai", mode: "chat" }],
      },
    ],
  ]);
  const fetcher = vi.fn(async (input: string, options?: RequestInit) => {
    if (input !== configPath && !input.startsWith(`${rootPath}/`)) throw new Error(`Unexpected request ${input}`);
    const pathname = input === configPath ? input : input.split("?")[0].slice(rootPath.length);
    if (pathname === `${prefix}/dataplanes/east/proxy/user/list`) {
      const page = Number(new URL(input, "http://localhost").searchParams.get("page") ?? 1);
      const users = {
        users: [{ user_id: `east-user-${page}` }],
        page,
        page_size: 25,
        total_pages: 2,
      };
      return Response.json(users);
    }
    if (pathname === `${prefix}/dataplanes/east/proxy/organization/update`)
      return options?.method === "PATCH" ? Response.json({}) : new Response(null, { status: 405 });
    if (pathname === `${prefix}/dataplanes/east/proxy/organization/delete`)
      return options?.method === "DELETE" ? Response.json([]) : new Response(null, { status: 405 });
    if (pathname === `${prefix}/dataplanes/east/proxy/key/list`)
      return Response.json({ keys: [{ key_alias: "East only", token: "east-key-id" }] });
    if (pathname === `${prefix}/dataplanes/west/proxy/key/list`)
      return Response.json({ keys: [{ key_alias: "West only", token: "west-key-id" }] });
    if (pathname === `${prefix}/dataplanes/east/proxy/key/generate`) {
      return Response.json({ detail: "Dataplane is unavailable." }, { status: 503 });
    }
    if (options?.method === "PUT" && pathname === `${prefix}/roles/conflict`) {
      return conflictingRoleSave();
    }
    if (pathname === `${prefix}/audit`) {
      return Response.json({ detail: "Scope no longer granted." }, { status: 403 });
    }
    if (!responses.has(pathname)) throw new Error(`Unexpected request ${pathname}`);
    return Response.json(responses.get(pathname));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function submitLogin() {
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "operator" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Global Control Plane" });
}

async function signIn() {
  render(<DashboardMode>Legacy dashboard</DashboardMode>);
  await submitLogin();
}

function overrideResponse(fetcher: ReturnType<typeof mockApi>, path: string, respond: () => Response) {
  const originalFetch = fetcher.getMockImplementation();
  if (!originalFetch) throw new Error("Expected an API fixture before overriding its response.");
  fetcher.mockImplementation(async (input, options) =>
    input.split("?")[0] === `${prefix}${path}` ? respond() : originalFetch(input, options),
  );
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("control plane dashboard mode", () => {
  it("returns to sign-in when the control plane rejects the session during a workspace request", async () => {
    const fetcher = mockApi({ scopes: ["dataplanes:read", "proxy:read"], bindings: null });
    await signIn();
    await screen.findByRole("option", { name: "East (ok)" });
    overrideResponse(fetcher, "/dataplanes/east/proxy/key/list", () =>
      Response.json({ detail: "Session token expired." }, { status: 401 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Virtual Keys" }));
    expect(await screen.findByRole("heading", { name: "Control Plane Login" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your control plane session expired. Sign in again.");
    await waitFor(() => expect(sessionStorage.getItem(controlPlaneSessionKey(prefix))).toBeNull());
    await submitLogin();
  });

  it("keeps the control-plane session when a dataplane rejects its credentials", async () => {
    const fetcher = mockApi({ scopes: ["dataplanes:read", "proxy:read"], bindings: null });
    await signIn();
    await screen.findByRole("option", { name: "East (ok)" });
    overrideResponse(fetcher, "/dataplanes/east/proxy/key/list", () =>
      Response.json(
        { detail: "Dataplane rejected the credential." },
        {
          status: 401,
          headers: { "X-LiteLLM-Dataplane": "east" },
        },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Virtual Keys" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("401: Dataplane rejected the credential.");
    expect(screen.getByRole("heading", { name: "Global Control Plane" })).toBeInTheDocument();
    expect(sessionStorage.getItem(controlPlaneSessionKey(prefix))).toBe("control-session");
  });

  it("lists saved and configured guardrails on the selected dataplane", async () => {
    const fetcher = mockApi({ scopes: ["dataplanes:read", "proxy:read"], bindings: null });
    await signIn();
    await screen.findByRole("option", { name: "East (ok)" });
    fireEvent.click(screen.getByRole("button", { name: "Guardrails", exact: true }));
    expect(await screen.findByRole("cell", { name: "Saved guardrail" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Configured guardrail" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      `${prefix}/dataplanes/east/proxy/v2/guardrails/list`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([
    { field: "model_name", value: "Renamed model", body: { model_name: "Renamed model" } },
    { field: "Provider model", value: "openai/replacement", body: { litellm_params: { model: "openai/replacement" } } },
  ])("edits a stored model's $field without resending listed parameters", async ({ field, value, body }) => {
    const fetcher = mockApi({ scopes: ["dataplanes:read", "proxy:read", "proxy:write"], bindings: null });
    await signIn();
    await screen.findByRole("option", { name: "East (ok)" });
    fireEvent.click(screen.getByRole("button", { name: "Models", exact: true }));
    await screen.findByRole("cell", { name: "East model" });
    fireEvent.click(screen.getByRole("button", { name: "Edit models" }));
    fireEvent.change(screen.getByLabelText(field), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    expect(fetcher).toHaveBeenCalledWith(
      `${prefix}/dataplanes/east/proxy/model/model-1/update`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify(body) }),
    );
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Edit models" })).not.toBeInTheDocument());
  });

  it("sends control plane authentication under the discovered server root", async () => {
    const fetcher = mockApi({ scopes: [], bindings: null, rootPath: "/gateway" });
    const otherPlaneKey = controlPlaneSessionKey(`/other${prefix}`);
    sessionStorage.setItem(otherPlaneKey, "other-session");
    await signIn();
    expect(fetcher).toHaveBeenCalledWith(`/gateway${prefix}/auth/login`, expect.objectContaining({ method: "POST" }));
    expect(fetcher).toHaveBeenCalledWith(
      `/gateway${prefix}/auth/me`,
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json", Authorization: "Bearer control-session" },
      }),
    );
    expect(sessionStorage.getItem(otherPlaneKey)).toBe("other-session");
  });

  it("keeps both dashboards and authentication disabled when discovery disables the UI", async () => {
    const fetcher = mockApi({ scopes: [], bindings: null, disabled: true });
    render(<DashboardMode>Legacy dashboard</DashboardMode>);
    expect(await screen.findByText("The Admin UI is disabled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy dashboard")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([configPath]);
  });

  it.each([
    {
      action: "Edit organizations",
      confirm: "Save",
      route: "update",
      method: "PATCH",
      body: { organization_alias: "Renamed", organization_id: "org-1" },
    },
    {
      action: "Delete organizations",
      confirm: "Confirm delete",
      route: "delete",
      method: "DELETE",
      body: { organization_ids: ["org-1"] },
    },
  ])("uses the dataplane HTTP method for $action", async ({ action, confirm, route, method, body }) => {
    const fetcher = mockApi({ scopes: ["dataplanes:read", "proxy:read", "proxy:write"], bindings: null });
    await signIn();
    await screen.findByRole("option", { name: "East (ok)" });
    fireEvent.click(screen.getByRole("button", { name: "Organizations" }));
    await screen.findByRole("cell", { name: "East organization" });
    fireEvent.click(screen.getByRole("button", { name: action }));
    if (route === "update")
      fireEvent.change(screen.getByLabelText("organization_alias"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: confirm, exact: true }));
    expect(fetcher).toHaveBeenCalledWith(
      `${prefix}/dataplanes/east/proxy/organization/${route}`,
      expect.objectContaining({ method, body: JSON.stringify(body) }),
    );
    await waitFor(() => expect(screen.queryByRole("heading", { name: action })).not.toBeInTheDocument());
  });

  it("loads later users with the dataplane's page and page_size parameters", async () => {
    const fetcher = mockApi({ scopes: ["dataplanes:read", "proxy:read"], bindings: null });
    await signIn();
    await screen.findByRole("option", { name: "East (ok)" });
    fireEvent.click(screen.getByRole("button", { name: "Users" }));
    expect(await screen.findByRole("cell", { name: "east-user-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("cell", { name: "east-user-2" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "east-user-1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledWith(
      `${prefix}/dataplanes/east/proxy/user/list?page=2&page_size=25`,
      expect.objectContaining({ method: "GET" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByRole("cell", { name: "east-user-1" })).toBeInTheDocument();
  });

  it("leaves unavailable legacy actions visible to a writer without sending a request", async () => {
    const fetcher = mockApi({ scopes: ["dataplanes:read", "proxy:read", "proxy:write"], bindings: null });
    await signIn();
    await screen.findByRole("option", { name: "East (ok)" });
    fireEvent.click(screen.getByRole("button", { name: "Virtual Keys" }));
    const key = await screen.findByRole("row", { name: /East only/ });
    const regenerate = within(key).getByRole("button", { name: "Regenerate key" });
    expect(screen.getByRole("button", { name: "Create key" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Bulk delete keys" })).toBeDisabled();
    expect(regenerate).toBeDisabled();
    const requestCount = fetcher.mock.calls.length;
    fireEvent.click(regenerate);
    expect(fetcher.mock.calls).toHaveLength(requestCount);
  });

  it("authenticates once and switches dataplanes without contacting either directly", async () => {
    const fetcher = mockApi({ scopes: ["dataplanes:read", "proxy:read", "fleet:read"], bindings: null });
    await signIn();
    expect(fetcher).toHaveBeenCalledWith(
      `${prefix}/auth/login`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "operator", password: "test-password" }),
        credentials: "omit",
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      `${prefix}/auth/me`,
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer control-session" },
      }),
    );
    expect(sessionStorage.getItem(controlPlaneSessionKey(prefix))).toBe("control-session");
    expect(localStorage.length).toBe(0);
    expect(await screen.findByRole("option", { name: "East (ok)" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "West (unreachable)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Virtual Keys" }));
    expect(await screen.findByRole("cell", { name: "East only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create key" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByRole("combobox", { name: "Dataplane" }), { target: { value: "west" } });
    expect(await screen.findByRole("cell", { name: "West only" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "East only" })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(`${prefix}/dataplanes/west/proxy/key/list?`),
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer control-session" },
        credentials: "omit",
        redirect: "error",
      }),
    );
    expect(fetcher.mock.calls.filter(([url]) => url === `${prefix}/auth/login`)).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url]) => url).every((url) => url === configPath || url.startsWith(prefix))).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fleet Models" }));
    expect(await screen.findByText("Partial results. Totals do not cover every dataplane.")).toBeInTheDocument();
    expect(screen.getByText("Unreachable: west (connection refused)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Control Plane Login" })).toBeInTheDocument();
    expect(sessionStorage.getItem(controlPlaneSessionKey(prefix))).toBeNull();
  });

  it("enforces the binding, leaves scoped admin actions visible, and shows upstream failures", async () => {
    const fetcher = mockApi({
      scopes: ["dataplanes:read", "dataplanes:write", "proxy:read", "proxy:write"],
      bindings: ["east"],
    });
    await signIn();
    expect(await screen.findByRole("option", { name: "East (ok)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /West/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Roles" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Vector Stores" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Dataplanes" }));
    expect(screen.getByRole("button", { name: "Create dataplane" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByRole("button", { name: "Virtual Keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    fireEvent.change(screen.getByLabelText("Key alias"), { target: { value: "new key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("503: Dataplane is unavailable.");
    expect(fetcher).toHaveBeenCalledWith(
      `${prefix}/dataplanes/east/proxy/key/generate`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ key_alias: "new key" }),
      }),
    );
    expect(fetcher.mock.calls.some(([url]) => url.includes("/west/"))).toBe(false);
  });

  it("leaves legacy worker mode on the existing dashboard", async () => {
    const fetcher = vi.fn(async () => Response.json({ is_control_plane: true, workers: [{ id: "west" }] }));
    vi.stubGlobal("fetch", fetcher);
    render(<DashboardMode>Legacy dashboard</DashboardMode>);
    expect(await screen.findByText("Legacy dashboard")).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });

  it("locks a role editor during save and preserves its inputs when the API rejects it", async () => {
    const save = Promise.withResolvers<Response>();
    mockApi({ scopes: ["roles:write", "audit:read"], bindings: null, conflictingRoleSave: () => save.promise });
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Roles" }));
    expect(await screen.findByText("No results.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create role" }));
    const name = screen.getByLabelText("Role name");
    fireEvent.change(name, { target: { value: "conflict" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(name).toBeDisabled();
    save.resolve(Response.json({ detail: "Role is managed by configuration." }, { status: 409 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("409: Role is managed by configuration.");
    expect(name).toBeEnabled();
    expect(name).toHaveValue("conflict");

    fireEvent.click(screen.getByRole("button", { name: "Audit Log" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("403: Scope no longer granted.");
  });
});
