import { NextResponse } from "next/server";
import { NIM_MODEL, OPENROUTER_MODEL } from "@/lib/nim";

export const runtime = "nodejs";
export const maxDuration = 30;

interface ProviderStatus {
  configured: boolean;
  ok: boolean;
  latencyMs?: number;
  status?: number;
  /** Key validity and quota details. Never includes secret values. */
  label?: string;
  usage?: number;
  limit?: number | null;
  error?: string;
}

async function checkOpenRouter(): Promise<ProviderStatus> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { configured: false, ok: false, error: "OPENROUTER_API_KEY is not set." };
  const start = Date.now();
  try {
    // Auth endpoint verifies the key and reports usage vs limit — exactly
    // what "is my paid key the problem?" needs, at zero token cost.
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { configured: true, ok: false, latencyMs, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` };
    }
    const data = (await res.json().catch(() => ({}))) as { data?: { label?: string; usage?: number; limit?: number | null } };
    return { configured: true, ok: true, latencyMs, label: data.data?.label, usage: data.data?.usage, limit: data.data?.limit ?? null };
  } catch (err) {
    return { configured: true, ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : "Request failed." };
  }
}

async function checkNvidia(): Promise<ProviderStatus> {
  const key = process.env.NVIDIA_NIM_API_KEY;
  if (!key) return { configured: false, ok: false, error: "NVIDIA_NIM_API_KEY is not set." };
  const start = Date.now();
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { configured: true, ok: false, latencyMs, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` };
    }
    return { configured: true, ok: true, latencyMs };
  } catch (err) {
    return { configured: true, ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : "Request failed." };
  }
}

export async function GET() {
  const [openrouter, nvidia] = await Promise.all([checkOpenRouter(), checkNvidia()]);
  return NextResponse.json({
    openrouter,
    nvidia,
    models: { openrouter: OPENROUTER_MODEL, nvidia: NIM_MODEL },
  });
}
