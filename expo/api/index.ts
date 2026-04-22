import { Hono } from "hono";
import { handle } from "hono/vercel";

const app = new Hono();

// IMPORTANT: match Vercel path
app.get("/api", (c) => {
  return c.json({ status: "ok", message: "API working (fixed)" });
});

export const config = {
  runtime: "nodejs",
};

export default handle(app);