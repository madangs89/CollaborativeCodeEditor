import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { prisma } from "./lib/prisma";

dotenv.config();

const app = express();
const port = 5000;
app.use(express.json());

app.use(
  cors({
    origin: "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);

// docker run --name my-postgres -e POSTGRES_USER=myuser -e POSTGRES_PASSWORD=mypassword -e POSTGRES_DB=mydb -p 5432:5432 -d postgres

// docker run --name my-postgres -e POSTGRES_USER=myuser -e POSTGRES_PASSWORD=mypassword -e POSTGRES_DB=mydb -p 5433:5432 -d postgres

app.get("/", async (req, res) => {
  const allUser = await prisma.user.findMany();
  console.log(allUser);

  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port http://localhost:${port}`);
});
