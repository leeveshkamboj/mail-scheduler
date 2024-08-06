const express = require("express");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const schedule = require("node-schedule");
const winston = require("winston");
const path = require("path");
const puppeteer = require("puppeteer");

dotenv.config();

const app = express();
app.use(express.json());

let jobs = {};

// Setup Winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

logger.add(
  new winston.transports.Console({
    format: winston.format.simple(),
  })
);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_PORT == 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

mongoose.connect(process.env.MONGO_URI);

const jobSchema = new mongoose.Schema({
  jobId: String,
  email: String,
  subject: String,
  body: String,
  sendAt: Date,
});

const Job = mongoose.model("Job", jobSchema);

const scheduleEmail = (jobId, email, subject, body, sendAt) => {
  const job = schedule.scheduleJob(sendAt, () => {
    transporter.sendMail(
      {
        from: `"Just Caffeinated" <${process.env.SMTP_FROM_EMAIL}>`,
        to: email,
        subject: subject,
        html: body,
      },
      (error, info) => {
        if (error) {
          logger.error(`Error sending email to ${email}: ${error}`);
        } else {
          logger.info(`Email sent successfully to ${email}: ${info.response}`);
        }
      }
    );
    delete jobs[jobId];
    Job.deleteOne({ jobId })
      .then(() => {
        logger.info(`Job ${jobId} deleted successfully`);
      })
      .catch((err) => {
        logger.error(`Failed to delete job ${jobId}: ${err}`);
      });
  });

  jobs[jobId] = job;
  logger.info(`New job scheduled: jobId ${jobId}, sendAt ${sendAt}`);
};

const loadJobs = async () => {
  const jobDocs = await Job.find({});
  jobDocs.forEach((jobDoc) => {
    scheduleEmail(
      jobDoc.jobId,
      jobDoc.email,
      jobDoc.subject,
      jobDoc.body,
      jobDoc.sendAt
    );
  });
};

app.post("/schedule-email", async (req, res) => {
  const { email, subject, body, sendAt } = req.body;
  const jobId = uuidv4();
  const job = new Job({ jobId, email, subject, body, sendAt });
  await job.save();
  scheduleEmail(jobId, email, subject, body, sendAt);
  res.json({ jobId });
});

app.delete("/cancel-email/:jobId", async (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs[jobId];

  if (job) {
    job.cancel();
    delete jobs[jobId];
    try {
      await Job.deleteOne({ jobId });
      logger.info(`Job ${jobId} deleted successfully`);
      res.json({ message: "Job cancelled successfully" });
    } catch (err) {
      logger.error(`Failed to delete job ${jobId}: ${err}`);
      res.status(500).json({ error: err.message });
    }
  } else {
    res.status(404).json({ message: "Job not found" });
  }
});

app.post("/send-email", async (req, res) => {
  const { email, subject, body, isInvoice } = req.body;
  let pdfBuffer;
  if (isInvoice) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setContent(body);
    pdfBuffer = await page.pdf({ format: "A4" });
    await browser.close();
  }

  transporter.sendMail(
    {
      from: `"Just Caffeinated" <${process.env.SMTP_FROM_EMAIL}>`,
      to: email,
      subject: subject,
      html: body,
      attachments: isInvoice && [
        {
          filename: "invoice.pdf",
          content: pdfBuffer,
          encoding: "base64",
        },
      ],
    },
    (error, info) => {
      if (error) {
        logger.error(`Error sending email to ${email}: ${error}`);
        res.status(500).json({ error: error.message });
      } else {
        logger.info(`Email sent successfully to ${email}: ${info.response}`);
        res.json({
          message: `Email sent successfully to ${email}: ${info.response}`,
        });
      }
    }
  );
});

const port = process.env.PORT || 3000;
mongoose.connection.once("open", () => {
  app.listen(port, () => {
    console.log(`Server started on port ${port}`);
    loadJobs();
  });
});
