import express from "express";
import {
  loginController,
  logoutController,
  refreshTokenController,
  registerController,
} from "./auth.controllers";

export const authRouter = express.Router();

authRouter.post("/register", registerController);
authRouter.post("/login", loginController);
authRouter.post("/refresh-token", refreshTokenController);
authRouter.post("/logout", logoutController);
