import { z } from "zod";

import { LoginSchema, RegisterSchema } from "./auth.zod";
import type { Prisma } from "../../generated/prisma/client";
import type { userSelect } from "./auth.prisma";
export type Login = z.infer<typeof LoginSchema>;
export type Register = z.infer<typeof RegisterSchema>;

export type safeUser = Prisma.UserGetPayload<{
  select: typeof userSelect;
}>;

interface AuthErrorResponse {
  message: string;
  success: false;
}

interface AuthSuccessResponse {
  message: string;
  success: true;
}

interface AuthSuccessResponseWithMeta extends AuthSuccessResponse {
  tokens: {
    accessToken: string;
    refreshToken: string;
  };
  data: safeUser;
}

export type AuthResponse =
  AuthErrorResponse | AuthSuccessResponse | AuthSuccessResponseWithMeta;
