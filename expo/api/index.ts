import { handle } from "hono/vercel";
import app from "../backend/hono";

export const config = {
  runtime: "nodejs",
};

export default handle(app);