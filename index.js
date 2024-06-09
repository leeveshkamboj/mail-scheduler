const express = require('express');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
app.use(express.json());

let jobs = {};

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT == 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const jobSchema = new mongoose.Schema({
    jobId: String,
    email: String,
    subject: String,
    body: String,
    sendAt: Date
});

const Job = mongoose.model('Job', jobSchema);

const scheduleEmail = (jobId, email, subject, body, sendAt) => {
    const delay = new Date(sendAt) - new Date();

    if (delay < 0) {
        console.log('Send time is in the past. Cannot schedule.');
        return;
    }

    const job = setTimeout(() => {
        transporter.sendMail({
            from: process.env.SMTP_USER,
            to: email,
            subject: subject,
            text: body
        }, (error, info) => {
            if (error) {
                console.log(`Error: ${error}`);
            } else {
                console.log(`Email sent: ${info.response}`);
            }
        });
        delete jobs[jobId];
        Job.deleteOne({ jobId }, (err) => {
            if (err) {
                console.error(`Failed to delete job ${jobId}: ${err}`);
            }
        });
    }, delay);

    jobs[jobId] = job;
};

const loadJobs = async () => {
    const jobDocs = await Job.find({});
    jobDocs.forEach((jobDoc) => {
        scheduleEmail(jobDoc.jobId, jobDoc.email, jobDoc.subject, jobDoc.body, jobDoc.sendAt);
    });
};

app.post('/schedule-email', async (req, res) => {
    const { email, subject, body, sendAt } = req.body;
    const jobId = uuidv4();
    const job = new Job({ jobId, email, subject, body, sendAt });
    await job.save();
    scheduleEmail(jobId, email, subject, body, sendAt);
    res.json({ jobId });
});

app.delete('/cancel-email/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs[jobId];

    if (job) {
        clearTimeout(job);
        delete jobs[jobId];
        await Job.deleteOne({ jobId });
        res.json({ message: 'Job cancelled successfully' });
    } else {
        res.status(404).json({ message: 'Job not found' });
    }
});

app.post('/send-email', (req, res) => {
    const { email, subject, body } = req.body;

    transporter.sendMail({
        from: process.env.SMTP_USER,
        to: email,
        subject: subject,
        text: body
    }, (error, info) => {
        if (error) {
            return res.status(500).json({ error: error.message });
        } else {
            res.json({ message: `Email sent: ${info.response}` });
        }
    });
});

const port = process.env.PORT || 3000;
mongoose.connection.once('open', () => {
    app.listen(port, () => {
        console.log(`Server started on port ${port}`);
        loadJobs();
    });
});
