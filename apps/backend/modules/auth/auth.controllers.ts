import type { Request, Response } from "express";
import type { AuthResponse, Login, Register, safeUser } from "./auth.types";
import { LoginSchema, RegisterSchema } from "./auth.zod";
import { prisma } from "../../lib/prisma";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import {
  clearCookie,
  generateRefreshToken,
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

    const refreshToken = generateRefreshToken();

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
    const refreshToken = generateRefreshToken();
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
      },
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        profilePhoto: user.profilePhoto,
      } as safeUser,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", success: false });
  }
};

export const refreshTokenController = async (
  req: Request,
  res: Response<AuthResponse>,
) => {
  try {
    const refreshToken = req.cookies["refreshToken"];
    if (!refreshToken) {
      clearCookie(res, "refreshToken");
      return res.status(401).json({
        message: "Refresh token not found",
        success: false,
      });
    }
    const hashedToken = hashToken(refreshToken);

    const isSessionValid = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashedToken },
    });

    if (!isSessionValid) {
      clearCookie(res, "refreshToken");

      return res.status(401).json({
        message: "Invalid refresh token",
        success: false,
      });
    }
    // checking is token revoke
    if (isSessionValid.revokedAt) {
      // need to handle grace window

      const diff = Date.now() - isSessionValid.revokedAt.getTime();

      // 10 seconds grace window
      if (diff < 10 * 1000) {
        return res.status(409).json({
          message:
            "Refresh in progress, please wait a few seconds and try again",
          success: false,
          code: "RETRY",
        });
      }

      await prisma.refreshToken.updateMany({
        where: { familyId: isSessionValid.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      clearCookie(res, "refreshToken");

      return res.status(401).json({
        message: "Refresh token revoked",
        success: false,
      });
    }

    if (isSessionValid.expiresAt <= new Date()) {
      clearCookie(res, "refreshToken");

      return res.status(401).json({
        message: "Refresh token expired",
        success: false,
      });
    }
    const user = await prisma.user.findUnique({
      where: { id: isSessionValid.userId },
      select: userSelect,
    });

    if (!user) {
      clearCookie(res, "refreshToken");

      return res.status(401).json({
        message: "User not found",
        success: false,
      });
    }

    const newRefreshToken = generateRefreshToken();

    const data = await prisma.$transaction(async (tx) => {
      const isClaimed = await tx.refreshToken.updateMany({
        where: { id: isSessionValid.id, revokedAt: null },
        data: {
          revokedAt: new Date(),
        },
      });

      if (isClaimed.count !== 1) return null;

      const result = await tx.refreshToken.create({
        data: {
          tokenHash: hashToken(newRefreshToken),
          expiresAt: isSessionValid.expiresAt,
          familyId: isSessionValid.familyId,
          userId: user.id,
          createdAt: new Date(),
        },
      });

      return result;
    });

    if (!data) {
      return res.status(409).json({
        message: "Refresh in progress, please wait a few seconds and try again",
        success: false,
        code: "RETRY",
      });
    }

    const newAccessToken = signToken(
      {
        id: user.id,
        email: user.email,
      },
      process.env.JWT_EXPIRATION as string,
    );

    setCookie(res, newRefreshToken, "refreshToken");
    return res.status(200).json({
      message: "Refresh token refreshed successfully",
      success: true,
      tokens: {
        accessToken: newAccessToken,
      },
      data: user,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", success: false });
  }
};

export const logoutController = async (
  req: Request,
  res: Response<AuthResponse>,
) => {
  try {
    const refreshToken = req.cookies["refreshToken"];
    if (!refreshToken) {
      clearCookie(res, "refreshToken");
      return res.status(200).json({
        message: "Logout successfully",
        success: true,
      });
    }
    const hashedToken = hashToken(refreshToken);
    const window = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashedToken },
    });
    if (!window) {
      clearCookie(res, "refreshToken");
      return res.status(200).json({
        message: "Logout successfully",
        success: true,
      });
    }

    await prisma.refreshToken.updateMany({
      where: { familyId: window.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    clearCookie(res, "refreshToken");
    return res.status(200).json({
      message: "Logout successfully",
      success: true,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", success: false });
  }
};
