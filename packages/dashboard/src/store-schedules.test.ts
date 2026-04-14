import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRootLeaf } from "./layout/layoutTree";
import { useStore } from "./store";

function resetStore() {
  const root = makeRootLeaf(null);
  useStore.setState({
    schedules: {},
    schedulesLoading: false,
    schedulesError: null,
    schedulerStatus: null,
    layout: root,
    focusedLeafId: root.id,
    activePane: null,
  });
}

const mockSchedule = {
  name: "test-sched",
  schedule: "0 9 * * 1-5",
  target: "isolated",
  prompt: "Run tests",
  workingDirectory: "~/workspace",
  enabled: true,
  state: {
    lastRunAt: null,
    lastRunStatus: null,
    nextRunAt: "2026-04-15T09:00:00Z",
    runCount: 0,
    consecutiveFailures: 0,
    currentRunId: null,
  },
};

describe("store: schedule methods", () => {
  beforeEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── fetchSchedules ───────────────────────────────────────

  describe("fetchSchedules", () => {
    it("loads schedules into store on success", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ "test-sched": mockSchedule }), {
          status: 200,
        }),
      );

      await useStore.getState().fetchSchedules();

      const { schedules, schedulesLoading, schedulesError } =
        useStore.getState();
      expect(schedules["test-sched"]).toBeDefined();
      expect(schedules["test-sched"].name).toBe("test-sched");
      expect(schedulesLoading).toBe(false);
      expect(schedulesError).toBeNull();
    });

    it("sets loading state on initial load", async () => {
      let resolveResponse: (value: Response) => void;
      const pending = new Promise<Response>((r) => {
        resolveResponse = r;
      });
      vi.spyOn(globalThis, "fetch").mockReturnValueOnce(pending);

      const fetchPromise = useStore.getState().fetchSchedules();

      expect(useStore.getState().schedulesLoading).toBe(true);

      resolveResponse!(new Response(JSON.stringify({}), { status: 200 }));
      await fetchPromise;

      expect(useStore.getState().schedulesLoading).toBe(false);
    });

    it("sets error on fetch failure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Server down" }), {
          status: 500,
        }),
      );

      await useStore.getState().fetchSchedules();

      const { schedulesLoading, schedulesError } = useStore.getState();
      expect(schedulesLoading).toBe(false);
      expect(schedulesError).toBe("Server down");
    });

    it("sets error on network failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Network error"),
      );

      await useStore.getState().fetchSchedules();

      const { schedulesError } = useStore.getState();
      expect(schedulesError).toBe("Network error");
    });
  });

  // ── deleteSchedule ─────────────────────────────────────────

  describe("deleteSchedule", () => {
    it("removes schedule from store on success", async () => {
      useStore.setState({
        schedules: { "test-sched": mockSchedule as never },
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      await useStore.getState().deleteSchedule("test-sched");

      expect(useStore.getState().schedules["test-sched"]).toBeUndefined();
    });

    it("throws on server error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
      );

      await expect(
        useStore.getState().deleteSchedule("nonexistent"),
      ).rejects.toThrow("Not found");
    });

    it("calls correct URL with encoded name", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );

      useStore.setState({
        schedules: { "my-sched": mockSchedule as never },
      });

      await useStore.getState().deleteSchedule("my-sched");

      expect(fetchSpy).toHaveBeenCalledWith("/api/schedules/my-sched", {
        method: "DELETE",
      });
    });
  });

  // ── runSchedule ────────────────────────────────────────────

  describe("runSchedule", () => {
    it("calls POST on correct URL", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );

      await useStore.getState().runSchedule("my-sched");

      expect(fetchSpy).toHaveBeenCalledWith("/api/schedules/my-sched/run", {
        method: "POST",
      });
    });

    it("throws on server error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Skipped" }), { status: 409 }),
      );

      await expect(
        useStore.getState().runSchedule("busy-sched"),
      ).rejects.toThrow("Skipped");
    });
  });

  // ── updateSchedule ─────────────────────────────────────────

  describe("updateSchedule", () => {
    it("updates schedule in store on success", async () => {
      const updated = { ...mockSchedule, prompt: "New prompt" };

      useStore.setState({
        schedules: { "test-sched": mockSchedule as never },
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, schedule: updated }), {
          status: 200,
        }),
      );

      await useStore.getState().updateSchedule("test-sched", {
        prompt: "New prompt",
      });

      expect(useStore.getState().schedules["test-sched"].prompt).toBe(
        "New prompt",
      );
    });

    it("sends PUT with JSON body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, schedule: mockSchedule }), {
          status: 200,
        }),
      );

      await useStore
        .getState()
        .updateSchedule("test-sched", { enabled: false });

      expect(fetchSpy).toHaveBeenCalledWith("/api/schedules/test-sched", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
    });

    it("throws on server error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
      );

      await expect(
        useStore.getState().updateSchedule("ghost", { prompt: "nope" }),
      ).rejects.toThrow("Not found");
    });
  });

  // ── fetchSchedulerStatus ───────────────────────────────────

  describe("fetchSchedulerStatus", () => {
    it("loads scheduler status", async () => {
      const status = {
        running: true,
        maxConcurrentRuns: 3,
        activeRuns: 1,
        queuedRuns: 0,
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(status), { status: 200 }),
      );

      await useStore.getState().fetchSchedulerStatus();

      expect(useStore.getState().schedulerStatus).toEqual(status);
    });

    it("silently ignores errors", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Network error"),
      );

      await useStore.getState().fetchSchedulerStatus();

      expect(useStore.getState().schedulerStatus).toBeNull();
    });
  });

  // ── updateSchedulerSettings ────────────────────────────────

  describe("updateSchedulerSettings", () => {
    it("updates maxConcurrentRuns in store", async () => {
      useStore.setState({
        schedulerStatus: {
          running: true,
          maxConcurrentRuns: 3,
          activeRuns: 0,
          queuedRuns: 0,
        },
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, maxConcurrentRuns: 5 }), {
          status: 200,
        }),
      );

      await useStore.getState().updateSchedulerSettings(5);

      expect(useStore.getState().schedulerStatus?.maxConcurrentRuns).toBe(5);
    });

    it("sends PUT with correct body", async () => {
      useStore.setState({
        schedulerStatus: {
          running: true,
          maxConcurrentRuns: 3,
          activeRuns: 0,
          queuedRuns: 0,
        },
      });

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );

      await useStore.getState().updateSchedulerSettings(10);

      expect(fetchSpy).toHaveBeenCalledWith("/api/scheduler/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrentRuns: 10 }),
      });
    });

    it("throws on server error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "must be positive" }), {
          status: 400,
        }),
      );

      await expect(
        useStore.getState().updateSchedulerSettings(0),
      ).rejects.toThrow("must be positive");
    });
  });
});
