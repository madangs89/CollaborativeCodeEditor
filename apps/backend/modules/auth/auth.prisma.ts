import type { Prisma } from "../../generated/prisma/client";

export const userSelect = {
  id: true,
  name: true,
  email: true,
  profilePhoto: true,
} as Prisma.UserSelect;
