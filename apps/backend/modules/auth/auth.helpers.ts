import jwt from "jsonwebtoken";
import type { StringValue } from "ms";
import crypto from "crypto";
import type { Response } from "express";
export const signToken = (payload: object, expiresIn: string) => {
  const token = jwt.sign(payload, process.env.JWT_SECRET as string, {
    algorithm: "HS256",
    subject: "accessToken",
    expiresIn: expiresIn as StringValue,
  });
  return token;
};

export const setCookie = (res: Response, token: string, name: string) => {
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie(name, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge:
      Number(process.env.JWT_REFRESH_EXPIRATION_Number) * 24 * 60 * 60 * 1000,
  });
};

export const generateAccessToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

export const hashToken = (token: string) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

export const clearCookie = (res: Response, name: string) => {
  res.clearCookie(name, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
};
