import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Mock @tauri-apps/api invoke globally so tests never hit real IPC.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
