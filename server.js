import express from 'express';
import admin from "firebase-admin";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {google} from 'googleapis';
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
const require = createRequire(import.meta.url);
const serviceAccount = require("./serviceAccountKey.json");
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
app.post("/login", async (req, res) => {
  const { idToken, accessToken } = req.body;

  try {
  
    const decoded = await admin.auth().verifyIdToken(idToken);

    console.log("Firebase User:", decoded.email);

      const oauth2Client = new google.auth.OAuth2(); 
      oauth2Client.setCredentials({ access_token: accessToken });
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      const gmailResponse = await gmail.users.messages.list({
      userId: "me",
      maxResults: 3,
    });

    res.json({
      success: true,
      firebase: {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
      },
      gmailPreview: gmailResponse.data.messages || [],
    });

  } catch (error) {
    console.error("Error verifying or accessing Gmail:", error.message);
    res.status(401).json({ success: false, message: "Login or Gmail access failed" });
  }
});
app.post("/emails", async (req, res) => {
  const { accessToken } = req.body;

  try {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
    });

    const messages = response.data.messages || [];
    res.json({ success: true, messages });

  } catch (error) {
    console.error("Error fetching emails:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch emails" });
  }
});
app.post("/email-details", async (req, res) => {
  const { accessToken, messageId } = req.body;

  try {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const email = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    if (!email.data.payload) {
      return res.status(400).json({ success: false, message: "Invalid email payload" });
    }

    const headers = email.data.payload.headers || [];
    const subject = headers.find(h => h.name === "Subject")?.value || "No Subject";
    const from = headers.find(h => h.name === "From")?.value || "Unknown Sender";

    let body = "";
    let attachmentText = "";

    const walkParts = async (parts) => {
      for (const part of parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          body += Buffer.from(part.body.data, 'base64').toString('utf-8');
        } else if (part.mimeType === "text/html" && part.body?.data && !body) {
          const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
          body += html.replace(/<[^>]*>?/gm, '');
        } else if (part.mimeType?.startsWith("multipart/") && part.parts) {
          await walkParts(part.parts); 
        } else if (part.filename && part.body?.attachmentId) {
          const attachment = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId,
            id: part.body.attachmentId,
          });
          const buffer = Buffer.from(attachment.data.data, 'base64');
          let decoded = "";
          try {
            if (part.filename.endsWith(".txt") || part.filename.endsWith(".csv")) {
              decoded = buffer.toString('utf-8');
            } else if (part.filename.endsWith(".pdf")) {
              const pdfData = await pdfParse(buffer); 
              decoded = pdfData.text;
            } else if (part.filename.endsWith(".docx")) {
              const docxData = await mammoth.extractRawText({ buffer });
              decoded = docxData.value;
            } else {
              decoded = "[Unsupported attachment type]";
            }
          } catch (err) {
            decoded = `[Failed to parse attachment ${part.filename}: ${err.message}]`;
          }

          if (decoded && decoded.length < 15000) {
            attachmentText += `\n\n[Attachment: ${part.filename}]\n${decoded}`;
          } else if (decoded) {
            attachmentText += `\n\n[Attachment: ${part.filename}] (Too large to include)`;
          }
        }
      }
    };

    const parts = email.data.payload.parts || [];
    await walkParts(parts);

    if (!body && email.data.payload?.body?.data) {
      body = Buffer.from(email.data.payload.body.data, 'base64').toString('utf-8');
    }
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD'],
      },
    });
    res.json({
      success: true,
      id: messageId,
      subject,
      from,
      body: body + attachmentText,
    });

  } catch (err) {
    console.error("Error reading email:", err.message);
    res.status(500).json({ success: false, message: "Failed to read email" });
  }
});
app.post('/delete-email', async (req, res) => {
  try {
    const { accessToken, emailId } = req.body;
    
    if (!accessToken || !emailId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing parameters' 
      });
    }

    const gmailResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${emailId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      }
    });

    if (gmailResponse.status === 204) {
      return res.json({ success: true });
    }
    
    const error = await gmailResponse.json();
    console.error('Full Gmail API error:', error);
    
    if (gmailResponse.status === 403) {
      return res.status(403).json({
        success: false,
        error: "Permission denied - needs reauthentication",
        authUrl: "/auth/google?scopes=gmail.modify" // Your auth endpoint
      });
    }
    
    return res.status(400).json({ 
      success: false, 
      error: error.error?.message || 'Failed to delete email' 
    });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});
app.listen(3000, () => console.log("Server running on http://localhost:3000"));
