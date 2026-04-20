import { z } from "zod";
import { google } from "googleapis";
import { createTRPCRouter, publicProcedure } from "../create-context";

const RestrictionStatusSchema = z.enum(['none', 'penny_player', 'play_up', 'open_division']);

const PlayerSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  club: z.string(),
  ageGroup: z.string(),
  division: z.string(),
  teamName: z.string(),
  dateOfBirth: z.string(),
  parentName: z.string(),
  parentPhone: z.string(),
  isAgeVerified: z.boolean(),
  photoUri: z.string().nullable(),
  weight: z.string(),
  checkedIn: z.boolean(),
  checkedInAt: z.string().nullable(),
  restrictionStatus: RestrictionStatusSchema.optional(),
  calculatedAgeGroup: z.string().optional(),
});

type Player = z.infer<typeof PlayerSchema>;

function getGoogleSheetsClient() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  console.log("Checking for GOOGLE_SERVICE_ACCOUNT_JSON, exists:", !!credentials);
  if (!credentials) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON environment variable not set. Please add it in the project settings.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(credentials);
    console.log("Service account parsed, client_email:", serviceAccount.client_email);
  } catch (e) {
    console.error("Failed to parse service account JSON:", e);
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON format. Must be valid JSON.");
  }
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function parseBoolean(value: string | undefined | null): boolean {
  if (!value) return false;
  return value.toLowerCase() === "true" || value === "1" || value.toLowerCase() === "yes";
}

function parseRestrictionStatus(value: string | undefined | null): 'none' | 'penny_player' | 'play_up' | 'open_division' {
  if (!value) return 'none';
  const normalized = value.toLowerCase().trim();
  if (normalized === 'penny_player' || normalized === 'penny player') return 'penny_player';
  if (normalized === 'play_up' || normalized === 'play up') return 'play_up';
  if (normalized === 'open_division' || normalized === 'open division') return 'open_division';
  return 'none';
}

function extractPhotoUrl(cell: string | undefined | null): string | null {
  if (!cell) return null;
  const raw = cell.toString().trim();
  if (!raw) return null;
  const imageMatch = raw.match(/=IMAGE\(\s*"([^"]+)"/i);
  if (imageMatch) return imageMatch[1];
  if (raw.startsWith('http')) return raw;
  return raw;
}

function rowToPlayer(row: string[], rowIndex: number): Player {
  return {
    id: row[0] || `row-${rowIndex}`,
    firstName: row[1] || "",
    lastName: row[2] || "",
    club: row[3] || "",
    ageGroup: row[4] || "",
    division: row[5] || "",
    teamName: row[6] || "",
    dateOfBirth: row[7] || "",
    parentName: row[8] || "",
    parentPhone: row[9] || "",
    isAgeVerified: parseBoolean(row[10]),
    photoUri: extractPhotoUrl(row[11]),
    weight: row[12] || "",
    checkedIn: parseBoolean(row[13]),
    checkedInAt: row[14] || null,
    restrictionStatus: parseRestrictionStatus(row[15]),
    calculatedAgeGroup: row[16] || undefined,
  };
}

function playerToRow(player: Player): string[] {
  const photoCell = player.photoUri && player.photoUri.startsWith('http')
    ? `=IMAGE("${player.photoUri.replace(/"/g, '\\"')}", 1)`
    : (player.photoUri || "");
  return [
    player.id,
    player.firstName,
    player.lastName,
    player.club,
    player.ageGroup,
    player.division,
    player.teamName || "",
    player.dateOfBirth,
    player.parentName,
    player.parentPhone,
    player.isAgeVerified ? "TRUE" : "FALSE",
    photoCell,
    player.weight,
    player.checkedIn ? "TRUE" : "FALSE",
    player.checkedInAt || "",
    player.restrictionStatus || "none",
    player.calculatedAgeGroup || "",
  ];
}

async function writePhotoFormula(
  sheets: ReturnType<typeof getGoogleSheetsClient>,
  spreadsheetId: string,
  sheetName: string,
  rowIndex: number,
  photoUri: string | null,
): Promise<void> {
  try {
    const rawUrl = photoUri && photoUri.startsWith('http') ? photoUri : "";
    const cellValue = rawUrl
      ? `=IMAGE("${rawUrl.replace(/"/g, '\\"')}", 1)`
      : (photoUri || "");
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!L${rowIndex}:L${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[cellValue]] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!R${rowIndex}:R${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[rawUrl]] },
    });
    console.log("Photo cell written as IMAGE formula at row:", rowIndex);
  } catch (err) {
    console.error("Failed to write photo IMAGE formula:", err);
  }
}

// Helper to find column index by header name
function findColumnIndex(headers: string[], ...searchTerms: string[]): number {
  return headers.findIndex(h => {
    const normalized = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    return searchTerms.some(term => normalized.includes(term.toLowerCase()));
  });
}

export const sheetsRouter = createTRPCRouter({
  testConnection: publicProcedure
    .input(z.object({ spreadsheetId: z.string() }))
    .mutation(async ({ input }) => {
      console.log("Testing connection to spreadsheet:", input.spreadsheetId);
      try {
        const sheets = getGoogleSheetsClient();
        const response = await sheets.spreadsheets.get({
          spreadsheetId: input.spreadsheetId,
        });
        console.log("Connection successful:", response.data.properties?.title);
        return {
          success: true,
          title: response.data.properties?.title || "Unknown",
          sheetNames: response.data.sheets?.map((s) => s.properties?.title) || [],
        };
      } catch (error) {
        console.error("Connection failed:", error);
        throw new Error("Failed to connect to spreadsheet. Check your credentials and spreadsheet ID.");
      }
    }),

  getPlayers: publicProcedure
    .input(z.object({ 
      spreadsheetId: z.string(),
      sheetName: z.string().optional().default("Players"),
    }))
    .query(async ({ input }) => {
      console.log("Fetching players from sheet:", input.sheetName);
      try {
        const sheets = getGoogleSheetsClient();
        const range = `${input.sheetName}!A2:Q`;
        
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: input.spreadsheetId,
          range,
          valueRenderOption: "FORMULA",
        });

        const rows = response.data.values || [];
        console.log(`Found ${rows.length} players`);
        
        const players = rows.map((row, index) => rowToPlayer(row as string[], index + 2));
        return players;
      } catch (error) {
        console.error("Failed to fetch players:", error);
        throw new Error("Failed to fetch players from spreadsheet");
      }
    }),

  getMetadata: publicProcedure
    .input(z.object({ 
      spreadsheetId: z.string(),
    }))
    .query(async ({ input }) => {
      console.log("Fetching metadata from spreadsheet");
      try {
        const sheets = getGoogleSheetsClient();
        
        // Fetch all potential metadata sheets
        // Use A1:Z to get headers too
        const [clubsResponse, ageGroupsResponse, divisionsResponse] = await Promise.all([
          sheets.spreadsheets.values.get({
            spreadsheetId: input.spreadsheetId,
            range: "clubs!A1:Z", 
          }).catch((err) => {
            console.log('Failed to fetch from clubs tab:', err.message);
            // Try "Clubs" with capital C just in case
            return sheets.spreadsheets.values.get({
              spreadsheetId: input.spreadsheetId,
              range: "Clubs!A1:Z", 
            }).catch(() => ({ data: { values: [] } }));
          }),
          sheets.spreadsheets.values.get({
            spreadsheetId: input.spreadsheetId,
            range: "AgeGroups!A2:D",
          }).catch(() => ({ data: { values: [] } })),
          sheets.spreadsheets.values.get({
            spreadsheetId: input.spreadsheetId,
            range: "Divisions!A2:B",
          }).catch(() => ({ data: { values: [] } })),
        ]);

        // Process Clubs & Teams
        const clubRows = clubsResponse.data.values || [];
        console.log('Raw club rows (including header):', clubRows.length);
        
        const teams: { id: string; name: string; club: string; ageGroup: string; division: string }[] = [];
        const uniqueClubs = new Set<string>();
        
        if (clubRows.length > 0) {
          // Normalize headers to handle case/spacing issues
          const headers = (clubRows[0] || []).map(h => (h || '').toString());
          console.log('Club sheet headers:', headers);
          
          // Try to identify columns with more robust matching
          let clubColIdx = findColumnIndex(headers, 'club', 'organization', 'org');
          let teamColIdx = findColumnIndex(headers, 'team', 'name'); // 'name' might match 'Club Name' so be careful
          
          // If 'name' matched 'Club Name' (col 0) and we didn't find a separate team column, 
          // we might need to look harder or assume defaults.
          
          // Refined fallback logic
          if (clubColIdx === -1 && teamColIdx === -1) {
              // No clear headers.
              if (headers.length >= 2) {
                   // Assume Col A = Club, Col B = Team
                   clubColIdx = 0;
                   teamColIdx = 1;
              } else {
                  // Just one column? Assume it's Club names.
                  clubColIdx = 0; 
              }
          } else if (clubColIdx !== -1 && teamColIdx === -1) {
              // Found Club column, but no Team column.
              // Look for any other column that might be team?
              // If only 1 column, then teamColIdx remains -1
              if (headers.length > 1) {
                 // Pick the column that isn't the club column
                 for (let i = 0; i < headers.length; i++) {
                   if (i !== clubColIdx) {
                     teamColIdx = i;
                     break;
                   }
                 }
              }
          }

          // Process rows (start from index 1 to skip header)
          for (let i = 1; i < clubRows.length; i++) {
            const row = clubRows[i];
            if (!row || row.length === 0) continue;

            const clubName = (clubColIdx !== -1 && row[clubColIdx]) ? row[clubColIdx].trim() : '';
            const teamName = (teamColIdx !== -1 && row[teamColIdx]) ? row[teamColIdx].trim() : '';
            
            // Age/Division columns
            const ageColIdx = findColumnIndex(headers, 'age', 'group', 'year');
            const divColIdx = findColumnIndex(headers, 'division', 'div', 'level');
            
            const ageGroup = (ageColIdx !== -1 && row[ageColIdx]) ? row[ageColIdx].trim() : '';
            const division = (divColIdx !== -1 && row[divColIdx]) ? row[divColIdx].trim() : '';

            if (clubName) {
              uniqueClubs.add(clubName);
            }

            // Strategy: 
            // 1. If we have both Club and Team Name, add that team.
            // 2. If we ONLY have Club Name (no team column or empty team cell), 
            //    we treat the Club itself as a "Team" (or create a default team for it).
            //    The user mentioned "17 teams per the 2nd tab". 
            //    If the tab lists teams, we should capture them.
            
            const effectiveTeamName = teamName || clubName; // If no specific team name, use club name
            
            if (effectiveTeamName) {
               // Avoid duplicates if multiple rows define the same team
               const existingTeam = teams.find(t => 
                 t.name.toLowerCase() === effectiveTeamName.toLowerCase() && 
                 t.club.toLowerCase() === clubName.toLowerCase()
               );
               
               if (!existingTeam) {
                teams.push({
                  id: `team-${teams.length + 1}`,
                  name: effectiveTeamName,
                  club: clubName,
                  ageGroup,
                  division,
                });
               }
            }
          }
        }
        
        const clubs = Array.from(uniqueClubs).map(name => ({
          id: name.toLowerCase().replace(/\s+/g, '-'),
          name,
        }));
        
        console.log(`Parsed ${clubs.length} clubs and ${teams.length} teams`);

        const ageGroups = (ageGroupsResponse.data.values || []).map((row: string[]) => ({
          id: row[0] || "",
          name: row[1] || row[0] || "",
          minAge: parseInt(row[2]) || 0,
          maxAge: parseInt(row[3]) || 0,
        }));

        const divisions = (divisionsResponse.data.values || []).map((row: string[]) => ({
          id: row[0] || "",
          name: row[1] || row[0] || "",
        }));

        return { clubs, teams, ageGroups, divisions };
      } catch (error) {
        console.error("Failed to fetch metadata:", error);
        throw new Error("Failed to fetch metadata from spreadsheet");
      }
    }),

  updatePlayer: publicProcedure
    .input(z.object({
      spreadsheetId: z.string(),
      sheetName: z.string().optional().default("Players"),
      player: PlayerSchema,
    }))
    .mutation(async ({ input }) => {
      console.log("Updating player:", input.player.id, "at", new Date().toISOString());
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const sheets = getGoogleSheetsClient();
          
          const getResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: input.spreadsheetId,
            range: `${input.sheetName}!A:A`,
          });

          const ids = getResponse.data.values || [];
          let rowIndex = -1;
          for (let i = 1; i < ids.length; i++) {
            if (ids[i]?.[0] === input.player.id) {
              rowIndex = i + 1;
              break;
            }
          }

          if (rowIndex === -1) {
            console.log("Player not found by ID, trying name+DOB match...");
            const allDataResponse = await sheets.spreadsheets.values.get({
              spreadsheetId: input.spreadsheetId,
              range: `${input.sheetName}!A2:Q`,
            });
            const allRows = allDataResponse.data.values || [];
            for (let i = 0; i < allRows.length; i++) {
              const row = allRows[i] as string[];
              const firstName = (row[1] || "").toLowerCase().trim();
              const lastName = (row[2] || "").toLowerCase().trim();
              const dob = (row[7] || "").trim();
              if (
                firstName === input.player.firstName.toLowerCase().trim() &&
                lastName === input.player.lastName.toLowerCase().trim() &&
                dob === input.player.dateOfBirth.trim()
              ) {
                rowIndex = i + 2;
                console.log("Found player by name+DOB match at row:", rowIndex);
                break;
              }
            }
          }

          if (rowIndex === -1) {
            console.log("Player not found, appending as new row");
            const values = [playerToRow(input.player)];
            await sheets.spreadsheets.values.append({
              spreadsheetId: input.spreadsheetId,
              range: `${input.sheetName}!A:Q`,
              valueInputOption: "USER_ENTERED",
              insertDataOption: "INSERT_ROWS",
              requestBody: { values },
            });
            console.log("Player appended as new row successfully");
            return { success: true, player: input.player };
          }

          const range = `${input.sheetName}!A${rowIndex}:Q${rowIndex}`;
          const values = [playerToRow(input.player)];

          await sheets.spreadsheets.values.update({
            spreadsheetId: input.spreadsheetId,
            range,
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
          });

          console.log("Player updated successfully at row:", rowIndex);
          return { success: true, player: input.player };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.error(`Update attempt ${attempt + 1}/${maxRetries} failed:`, lastError.message);
          if (attempt < maxRetries - 1) {
            const delay = Math.min(500 * Math.pow(2, attempt), 4000);
            console.log(`Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      console.error("All update attempts failed for player:", input.player.id);
      throw new Error(`Failed to update player after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
    }),

  addPlayer: publicProcedure
    .input(z.object({
      spreadsheetId: z.string(),
      sheetName: z.string().optional().default("Players"),
      player: PlayerSchema.omit({ id: true }),
    }))
    .mutation(async ({ input }) => {
      console.log("Adding new player:", input.player.firstName, input.player.lastName, "at", new Date().toISOString());
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const sheets = getGoogleSheetsClient();

          const existingResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: input.spreadsheetId,
            range: `${input.sheetName}!A2:Q`,
          });
          const existingRows = existingResponse.data.values || [];
          const duplicate = existingRows.find((row: string[]) => {
            const firstName = (row[1] || "").toLowerCase().trim();
            const lastName = (row[2] || "").toLowerCase().trim();
            const dob = (row[7] || "").trim();
            return (
              firstName === input.player.firstName.toLowerCase().trim() &&
              lastName === input.player.lastName.toLowerCase().trim() &&
              dob === input.player.dateOfBirth.trim()
            );
          });

          if (duplicate) {
            console.log("Duplicate player found, updating instead of adding");
            const existingId = duplicate[0] || `player-${Date.now()}`;
            const updatedPlayer: Player = { ...input.player, id: existingId };
            const rowIdx = existingRows.indexOf(duplicate) + 2;
            await sheets.spreadsheets.values.update({
              spreadsheetId: input.spreadsheetId,
              range: `${input.sheetName}!A${rowIdx}:Q${rowIdx}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [playerToRow(updatedPlayer)] },
            });
            return { success: true, player: updatedPlayer };
          }

          const newId = `player-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
          const newPlayer: Player = {
            ...input.player,
            id: newId,
          };

          const values = [playerToRow(newPlayer)];

          await sheets.spreadsheets.values.append({
            spreadsheetId: input.spreadsheetId,
            range: `${input.sheetName}!A:Q`,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values },
          });

          console.log("Player added successfully with ID:", newId);
          return { success: true, player: newPlayer };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.error(`Add attempt ${attempt + 1}/${maxRetries} failed:`, lastError.message);
          if (attempt < maxRetries - 1) {
            const delay = Math.min(500 * Math.pow(2, attempt), 4000);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      throw new Error(`Failed to add player after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
    }),

  getSheetData: publicProcedure
    .input(z.object({
      spreadsheetId: z.string(),
      sheetName: z.string().optional(),
    }))
    .query(async ({ input }) => {
      console.log("Fetching raw sheet data for import:", input.spreadsheetId);
      try {
        const sheets = getGoogleSheetsClient();
        
        const spreadsheetMeta = await sheets.spreadsheets.get({
          spreadsheetId: input.spreadsheetId,
        });
        
        const sheetNames = spreadsheetMeta.data.sheets?.map(s => s.properties?.title || '') || [];
        const targetSheet = input.sheetName || sheetNames[0] || 'Sheet1';
        
        console.log("Available sheets:", sheetNames);
        console.log("Using sheet:", targetSheet);
        
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: input.spreadsheetId,
          range: `${targetSheet}!A:Z`,
        });

        const rows = response.data.values || [];
        console.log(`Found ${rows.length} rows in sheet`);
        
        if (rows.length < 2) {
          throw new Error("Sheet must have a header row and at least one data row");
        }

        const headers = rows[0] as string[];
        const data = rows.slice(1) as string[][];

        return {
          success: true,
          title: spreadsheetMeta.data.properties?.title || 'Unknown',
          sheetNames,
          selectedSheet: targetSheet,
          headers,
          data,
        };
      } catch (error) {
        console.error("Failed to fetch sheet data:", error);
        const message = error instanceof Error ? error.message : "Failed to fetch sheet data";
        throw new Error(message);
      }
    }),
});
