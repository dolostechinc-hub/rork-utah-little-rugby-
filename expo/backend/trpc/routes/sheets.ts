import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";

export const sheetsRouter = createTRPCRouter({
  testConnection: publicProcedure
    .input(z.object({ spreadsheetId: z.string() }))
    .mutation(async () => {
      return { success: true, message: "Safe mode" };
    }),

  getPlayers: publicProcedure
    .input(z.object({ spreadsheetId: z.string() }))
    .query(async () => {
      return [];
    }),
});
