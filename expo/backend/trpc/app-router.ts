import { createTRPCRouter } from "./create-context";
import { sheetsRouter } from "./routes/sheets";

export const appRouter = createTRPCRouter({
  sheets: sheetsRouter,
});

export type AppRouter = typeof appRouter;
