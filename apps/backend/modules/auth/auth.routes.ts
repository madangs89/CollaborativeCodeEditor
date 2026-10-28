import express from "express";
import { register } from "./auth.controllers";

export const authRouter = express.Router();

authRouter.post("/register", register);
