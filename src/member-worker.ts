import type { Database } from "./db.js";
import {
  memberGrowthEnabled,
  memberSchema,
  scheduleGrowthTasks,
  runGrowthTasks,
} from "./member-growth.js";
export function startMemberWorker(
  db: Database,
  log: (x: { code: string }) => void,
) {
  let stopped = false,
    running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running || !memberGrowthEnabled()) return;
    running = (async () => {
      try {
        if (await memberSchema(db)) {
          await scheduleGrowthTasks(db);
          await runGrowthTasks(db);
        }
      } catch {
        log({ code: "member_worker_failed" });
      } finally {
        running = undefined;
      }
    })();
  };
  const timer = setInterval(tick, 30000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
