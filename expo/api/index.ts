import { Hono } from "hono";
import { handle } from "hono/vercel";

import app from "../backend/hono";

export const config = {
  runtime: "nodejs",
};

const root = new Hono();

root.route("/api", app);

root.get("/", (c) =>
  c.json({ status: "ok", message: "Youth Sports Registration API (Vercel)" }),
);

export default handle(root);
