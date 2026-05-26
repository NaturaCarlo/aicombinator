import { test, expect, type Page } from "@playwright/test";

const API_BASE_URL = process.env.API_BASE_URL || "https://api.aicombinator.live";
const APP_BASE_URL = process.env.APP_BASE_URL || "https://aicombinator.live";

interface CompanyStatusResponse {
  companyId: string;
  name: string;
  state: string;
  hostedDomain?: string | null;
  emailDomain?: string | null;
  turnCount?: number;
}

interface AgentResponse {
  id: string;
  name: string;
  role: string;
  status: string;
  icon?: string | null;
  email_address?: string | null;
}

interface TaskResponse {
  id: string;
  title: string;
  status: string;
  artifact?: string | null;
}

interface DocumentResponse {
  title: string;
  path: string;
}

interface ArtifactResponse {
  title: string;
  path: string;
  kind: string;
}

async function getSessionToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies(APP_BASE_URL);
  const sessionCookie = cookies.find((cookie) => cookie.name === "__session");
  if (!sessionCookie?.value) {
    throw new Error("Missing Clerk __session cookie after auth setup");
  }

  return sessionCookie.value;
}

async function api<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }

  return res.json() as Promise<T>;
}

test.describe.serial("live launch smoke", () => {
  test.setTimeout(600_000);

  test("launches a production company with real outputs", async ({ page }) => {
    const companyName = `Live Output ${Date.now().toString().slice(-6)}`;
    const idea = [
      "An AI concierge that helps dog owners in Austin book recurring pet transport,",
      "dispatch drivers, and convert local apartment residents into subscribers.",
      "The team must ship a real landing page and backend skeleton immediately.",
    ].join(" ");

    await page.goto(`${APP_BASE_URL}/launch`);
    const token = await getSessionToken(page);
    await page.getByPlaceholder("Company name (e.g. TutorAI)").fill(companyName);
    await page
      .getByPlaceholder("Describe what this company should build and do... e.g. 'An AI tutoring marketplace that matches students with personalized learning paths for math and science. Target college students.'")
      .fill(idea);
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Launch Company" }).click();

    await page.waitForURL(/\/company\/[^/]+$/, { timeout: 120_000 });
    const companyUrl = page.url();
    const companyId = companyUrl.split("/company/")[1]?.split("?")[0];
    expect(companyId).toBeTruthy();

    const pollStart = Date.now();
    let status!: CompanyStatusResponse;
    let agents: AgentResponse[] = [];
    let tasks: TaskResponse[] = [];
    let documents: DocumentResponse[] = [];
    let artifacts: ArtifactResponse[] = [];

    while (Date.now() - pollStart < 240_000) {
      status = await api<CompanyStatusResponse>(token, `/api/companies/${companyId}/status`);
      const [agentData, taskData, documentData] = await Promise.all([
        api<{ agents: AgentResponse[] }>(token, `/api/companies/${companyId}/agents`),
        api<{ tasks: TaskResponse[] }>(token, `/api/companies/${companyId}/tasks`),
        api<{ documents: DocumentResponse[]; artifacts: ArtifactResponse[] }>(
          token,
          `/api/companies/${companyId}/documents`,
        ),
      ]);

      agents = agentData.agents;
      tasks = taskData.tasks;
      documents = documentData.documents;
      artifacts = documentData.artifacts;

      const doneTasks = tasks.filter((task) => task.status === "done");
      const readableDocs = documents.filter((doc) =>
        /mission|executive brief|market analysis|day 1 recap|plan|architecture/i.test(doc.title),
      );
      const realArtifacts = artifacts.filter((artifact) =>
        ["landing_page", "app_page", "backend", "creative_asset"].includes(artifact.kind),
      );

      console.log(JSON.stringify({
        companyId,
        state: status.state,
        turns: status.turnCount,
        agents: agents.length,
        docs: documents.map((doc) => doc.path),
        doneTasks: doneTasks.length,
        artifacts: artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`),
      }));

      if (
        status.state === "running"
        && !!status.hostedDomain
        && !!status.emailDomain
        && agents.length >= 7
        && agents.every((agent) => Boolean(agent.email_address))
        && readableDocs.length >= 3
        && doneTasks.length >= 2
        && realArtifacts.length >= 1
      ) {
        break;
      }

      await page.waitForTimeout(15_000);
    }

    const doneTasks = tasks.filter((task) => task.status === "done");
    const readableDocs = documents.filter((doc) =>
      /mission|executive brief|market analysis|day 1 recap|plan|architecture/i.test(doc.title),
    );
    const realArtifacts = artifacts.filter((artifact) =>
      ["landing_page", "app_page", "backend", "creative_asset"].includes(artifact.kind),
    );

    expect(status.state).toBe("running");
    expect(status.hostedDomain).toBeTruthy();
    expect(status.emailDomain).toBeTruthy();
    expect(agents.length).toBeGreaterThanOrEqual(7);
    expect(agents.every((agent) => Boolean(agent.email_address))).toBe(true);
    expect(readableDocs.length).toBeGreaterThanOrEqual(3);
    expect(doneTasks.length).toBeGreaterThanOrEqual(2);
    expect(realArtifacts.length).toBeGreaterThanOrEqual(1);

    await page.goto(`${APP_BASE_URL}/company/${companyId}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Launch Access")).toBeVisible();
    await expect(page.getByText("Reserved hosted domain")).toBeVisible();
    await expect(page.getByText("Company inbox")).toBeVisible();
    await expect(page.getByText("CEO inbox")).toBeVisible();
    await expect(page.getByText("Artifacts")).toBeVisible();
    await expect(page.getByText("Tasks")).toBeVisible();

    const emailDomain = status.emailDomain!;
    await expect(page.getByText(`info@${emailDomain}`)).toBeVisible();
    await expect(page.getByText(status.hostedDomain!, { exact: false })).toBeVisible();

    const ceoAgent = agents.find((agent) => agent.role === "ceo");
    expect(ceoAgent?.email_address).toBeTruthy();
    await expect(page.getByText(ceoAgent!.email_address!, { exact: false })).toBeVisible();
  });
});
