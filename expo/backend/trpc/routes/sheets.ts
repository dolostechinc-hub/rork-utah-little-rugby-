import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";

const playerSchema = z.record(z.string(), z.any());

export const sheetsRouter = createTRPCRouter({
  testConnection: publicProcedure
    .input(z.object({ spreadsheetId: z.string() }))
    .mutation(async () => {
      return { success: true, message: "Safe mode" } as const;
    }),

  getPlayers: publicProcedure
    .input(
      z.object({
        spreadsheetId: z.string(),
        sheetName: z.string().optional(),
      })
    )
    .query(async () => {
      return [] as any[];
    }),

  getMetadata: publicProcedure
    .input(z.object({ spreadsheetId: z.string() }))
    .query(async () => {
      return {
        clubs: [] as { id: string; name: string }[],
        teams: [] as { id: string; name: string; club?: string; ageGroup?: string; division?: string }[],
        ageGroups: [] as { id: string; name: string }[],
        divisions: [] as { id: string; name: string }[],
        title: "",
      };
    }),

  updatePlayer: publicProcedure
    .input(
      z.object({
        spreadsheetId: z.string(),
        sheetName: z.string().optional(),
        player: playerSchema,
      })
    )
    .mutation(async ({ input }) => {
      return { success: true, player: input.player as any };
    }),

  addPlayer: publicProcedure
    .input(
      z.object({
        spreadsheetId: z.string(),
        sheetName: z.string().optional(),
        player: playerSchema,
      })
    )
    .mutation(async ({ input }) => {
      const player = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(input.player as Record<string, any>),
      };
      return { success: true, player };
    }),
});
