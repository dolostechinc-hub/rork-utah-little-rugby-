import { z } from "zod";
import { google } from "googleapis";
import { createTRPCRouter, publicProcedure } from "../create-context";

function getGoogleSheetsClient() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credentials) {
    console.log("⚠️ GOOGLE_SERVICE_ACCOUNT_JSON missing");
    throw new Error("Missing credentials");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(credentials);
  } catch {
    throw new Error("Invalid JSON credentials");
  }

  return google.sheets({
    version: "v4",
    auth: new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    }),
  });
}

export const sheetsRouter = createTRPCRouter({
  testConnection: publicProcedure
    .input(z.object({ spreadsheetId: z.string() }))
    .mutation(async ({ input }) => {
      if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        return { success: false, message: "No credentials set" };
      }

      try {
        const sheets = getGoogleSheetsClient();
        const res = await sheets.spreadsheets.get({
          spreadsheetId: input.spreadsheetId,
        });

        return {
          success: true,
          title: res.data.properties?.title || "Unknown",
        };
      } catch (err) {
        console.error(err);
        return { success: false, message: "Connection failed" };
      }
    }),

  getPlayers: publicProcedure
    .input(z.object({ spreadsheetId: z.string() }))
    .query(async () => {
      console.log("Returning empty players (safe mode)");
      return [];
    }),
});
