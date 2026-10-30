import type { Request, Response } from "express";
import type { AuthResponse, Login, Register } from "./auth.types";
import { LoginSchema, RegisterSchema } from "./auth.zod";
import { prisma } from "../../lib/prisma";
import bcrypt from "bcrypt";
import {
  generateAccessToken,
  hashToken,
  setCookie,
  signToken,
} from "./auth.helpers";
import { userSelect } from "./auth.prisma";

export const registerController = async (
  req: Request<{}, {}, Register>,
  res: Response<AuthResponse>,
) => {
  try {
    const data = RegisterSchema.safeParse(req.body);
    if (!data.success) {
      return res.status(400).json({
        message: "Invalid request data",
        success: false,
      });
    }
    let { email, name, password } = data.data;
    if (!email || !password || !name) {
      return res.status(400).json({
        message: "Email and password and name are required",
        success: false,
      });
    }

    const isUserAlreadyExists = await prisma.user.findUnique({
      where: { email },
    });

    if (isUserAlreadyExists) {
      return res.status(400).json({
        message: "User already exists",
        success: false,
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const randomUuid = crypto.randomUUID();

    const accessToken = signToken(
      {
        id: randomUuid,
        email,
      },
      process.env.JWT_EXPIRATION as string,
    );

    const refreshToken = generateAccessToken();

    const familyId = crypto.randomUUID();

    const user = await prisma.user.create({
      data: {
        id: randomUuid,
        email,
        name,
        passwordHash,
        refreshTokens: {
          create: {
            expiresAt: new Date(
              Date.now() +
                Number(process.env.JWT_REFRESH_EXPIRATION_Number) *
                  24 *
                  60 *
                  60 *
                  1000,
            ),
            familyId: familyId,
            tokenHash: hashToken(refreshToken),
            createdAt: new Date(),
          },
        },
      },
      select: userSelect,
    });
    setCookie(res, refreshToken, "refreshToken");

    return res.status(201).json({
      message: "User registered successfully",
      success: true,
      tokens: {
        accessToken,
        refreshToken,
      },
      data: user,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", success: false });
  }
};

export const loginController = async (
  req: Request<{}, {}, Login>,
  res: Response<AuthResponse>,
) => {
  try {
    const data = LoginSchema.safeParse(req.body);
    if (!data.success) {
      return res.status(400).json({
        message: "Invalid request data",
        success: false,
      });
    }
    let { email, password } = data.data;
    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
        success: false,
      });
    }
    const user = await prisma.user.findUnique({
      where: { email },
      select: { ...userSelect, passwordHash: true },
    });

    if (!user) {
      return res.status(400).json({
        message: "User not found",
        success: false,
      });
    }
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(400).json({
        message: "Invalid password",
        success: false,
      });
    }
    const accessToken = signToken(
      {
        id: user.id,
        email,
      },
      process.env.JWT_EXPIRATION as string,
    );
    const refreshToken = generateAccessToken();
    const familyId = crypto.randomUUID();

    await prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(
          Date.now() +
            Number(process.env.JWT_REFRESH_EXPIRATION_Number) *
              24 *
              60 *
              60 *
              1000,
        ),
        familyId: familyId,
        userId: user.id,
        createdAt: new Date(),
      },
    });
    setCookie(res, refreshToken, "refreshToken");
    return res.status(200).json({
      message: "User logged in successfully",
      success: true,
      tokens: {
        accessToken,
        refreshToken,
      },
      data: user,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", success: false });
  }
};
