import type { Request, Response } from "express";

export const register = async (
  req: Request<{}, {}, { name: string; email: string; password: string }>,
  res: Response,
) => {
  try {
    const { name, email, password } = req.body;
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Internal server error", success: false });
  }
};
