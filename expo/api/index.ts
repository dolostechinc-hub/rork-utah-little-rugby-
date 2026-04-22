import { Hono } from "hono";
import { handle } from "hono/vercel";

const app = new Hono();

app.get("/", (c) => {
  return c.json({ status: "ok", message: "API working" });
});

export const config = {
  runtime: "nodejs",
};

export default handle(app);