import { API_BASE_URL } from "./constants.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string,
  ) {
    super(message || `API error ${status}: ${JSON.stringify(body)}`);
    this.name = "ApiError";
  }
}

export class ApiClient {
  constructor(
    private token: string,
    private baseUrl: string = API_BASE_URL,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      throw new ApiError(res.status, data, `${method} ${path} returned ${res.status}`);
    }

    return data as T;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  async delete(path: string): Promise<void> {
    await this.request<unknown>("DELETE", path);
  }

  /** Make a raw request without parsing (for checking status codes) */
  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /** Make an unauthenticated request (for testing 401s) */
  async unauthenticated(method: string, path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
    });
  }
}
