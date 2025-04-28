// index.js
// Import necessary libraries
import express from 'express'; // Web framework
import * as line from '@line/bot-sdk'; // LINE Bot SDK
import { GoogleGenerativeAI } from '@google/generative-ai'; // Gemini SDK
import dotenv from 'dotenv'; // To load environment variables locally

// Load environment variables from .env file for local development
dotenv.config();

// --- Configuration ---
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const geminiApiKey = process.env.GEMINI_API_KEY || '';

// Basic validation
if (!lineConfig.channelAccessToken || !lineConfig.channelSecret || !geminiApiKey) {
  console.error('Missing required environment variables: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, GEMINI_API_KEY');
  process.exit(1); // Exit if configuration is missing
}

// Initialize LINE Bot client
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});
const lineMiddleware = line.middleware(lineConfig); // Middleware to verify LINE signature

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // Or another suitable model
console.log("Gemini API configured.");

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000; // Vercel provides the PORT environment variable

// --- State Management (In-Memory - Replace with Database for Production) ---
// WARNING: This object will reset on Vercel restarts. Use a persistent database (like Vercel KV).
// Structure: groupPreferences = { "groupId": {"userId": "language_code", ...} }
const groupPreferences = {};
// Structure: userPreferences = { "userId": "language_code" } // For direct messages
const userPreferences = {};

// --- Helper Functions ---

// Gets user display name from LINE
async function getUserProfile(userId) {
  try {
    const profile = await lineClient.getProfile(userId);
    return profile.displayName;
  } catch (error) {
    console.error(`Error getting profile for ${userId}:`, error.response ? error.response.data : error.message);
    return "Someone"; // Fallback name
  }
}

// Translates text using Gemini
async function translateText(text, targetLanguage) {
  if (!text || !targetLanguage) {
    return null;
  }

  // Simple prompt for translation, asking for only the result
  const prompt = `Translate the following text to ${targetLanguage}. Output only the translated text, without any introductory phrases or explanations: "${text}"`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const response = result.response;

    // Check if the response has text content
    if (response && response.text) {
      const translation = response.text().trim().replace(/^["`]|["`]$/g, ''); // Clean potential quotes
      console.log(`Gemini translation to ${targetLanguage}: ${translation}`);
      return translation;
    } else {
      console.warn(`Gemini returned no content for prompt: ${prompt}`);
      // Log safety ratings if available
      if (response && response.promptFeedback) {
        console.warn(`Prompt Feedback: ${JSON.stringify(response.promptFeedback)}`);
      }
      return null; // Indicate translation failure
    }
  } catch (error) {
    console.error(`Gemini API error during translation to ${targetLanguage}:`, error);
    return null; // Indicate translation failure
  }
}

// Gets the set of unique target languages needed for a group, excluding the sender's
function getTargetLanguages(groupId, sourceUserId) {
  const targets = new Set();
  const prefs = groupPreferences[groupId];
  if (prefs) {
    const senderLang = prefs[sourceUserId]; // Sender's preferred language
    for (const userId in prefs) {
      const langCode = prefs[userId];
      // Add language if it's set and different from the sender's language
      // (or if the sender's language isn't set, translate for everyone)
      if (langCode && (!senderLang || langCode.toLowerCase() !== senderLang.toLowerCase())) {
        targets.add(langCode.toLowerCase()); // Use lowercase for consistency
      }
    }
  }
  console.log(`Target languages for group ${groupId} (excluding sender ${sourceUserId}'s lang): ${Array.from(targets)}`);
  return targets;
}


// --- LINE Webhook Route ---

// Define the webhook endpoint. LINE will send events here.
// The 'lineMiddleware' verifies the request signature BEFORE your handler runs.
app.post('/callback', lineMiddleware, (req, res) => {
  // req.body.events contains the webhook events
  // We use Promise.all to handle all events concurrently
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result)) // Send success response to LINE
    .catch((err) => {
      console.error("Error processing events:", err);
      res.status(500).end(); // Send error response to LINE
    });
});

// --- Event Handler ---

async function handleEvent(event) {
  console.log('Received event:', JSON.stringify(event));

  // Ignore events that are not messages, joins, follows, or member joins
  if (!['message', 'join', 'follow', 'memberJoined'].includes(event.type)) {
    return null;
  }

  // --- Join Event (Bot added to Group/Room) ---
  if (event.type === 'join') {
    const sourceType = event.source.type;
    let sourceId;

    if (sourceType === 'group') {
      sourceId = event.source.groupId;
      console.log(`Bot joined group: ${sourceId}`);
      // Initialize preferences for this group if not already present
      if (!groupPreferences[sourceId]) {
        groupPreferences[sourceId] = {};
        console.log(`Initialized preferences for group ${sourceId}`);
      }
    } else if (sourceType === 'room') {
      sourceId = event.source.roomId;
      console.log(`Bot joined room: ${sourceId}`);
      // Initialize preferences for this room (using same structure as group)
       if (!groupPreferences[sourceId]) {
        groupPreferences[sourceId] = {};
        console.log(`Initialized preferences for room ${sourceId}`);
      }
    } else {
      console.log("Bot joined unknown source type:", sourceType);
      return null; // Don't handle unknown types
    }

    // Send welcome message
    const welcomeMessage = {
      type: 'text',
      text: `Hello! I'm the translator bot.
Please tell me your preferred language by typing:
@TranslatorBot language [language name or code]

For example:
@TranslatorBot language English
@TranslatorBot language th`,
    };
    try {
      await lineClient.replyMessage({
         replyToken: event.replyToken,
         messages: [welcomeMessage]
      });
      console.log(`Sent welcome message to ${sourceType} ${sourceId}`);
    } catch (error) {
      console.error(`Failed to send welcome message to ${sourceType} ${sourceId}:`, error.response ? error.response.data : error.message);
    }
    return null; // Handled
  }

  // --- Follow Event (Bot added as Friend - 1-on-1 chat) ---
   if (event.type === 'follow') {
     const userId = event.source.userId;
     console.log(`User ${userId} followed the bot.`);
     // Initialize user preference if not present
     if (!userPreferences[userId]) {
       userPreferences[userId] = null; // Default to null
     }
     const welcomeMessage = {
       type: 'text',
       text: `Hello! Thanks for adding me.
To set your preferred language for translation, type:
language [language name or code]

For example:
language Spanish
language ja`,
     };
     try {
       await lineClient.replyMessage({
         replyToken: event.replyToken,
         messages: [welcomeMessage]
       });
     } catch (error) {
       console.error(`Failed to send follow message to user ${userId}:`, error.response ? error.response.data : error.message);
     }
     return null; // Handled
   }

   // --- Member Joined Event ---
   if (event.type === 'memberJoined') {
        const groupId = event.source.groupId;
        const userIds = event.joined.members.map(member => member.userId);
        console.log(`Members ${userIds.join(', ')} joined group ${groupId}`);
        // Cannot reply here, could push a message but might be noisy.
        // Rely on the initial join message or users asking.
        return null; // Handled (logged)
   }


  // --- Message Event ---
  // We only handle text messages for now
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null; // Ignore non-text messages
  }

  const messageText = event.message.text;
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const sourceType = event.source.type; // 'user', 'group', or 'room'
  const sourceId = event.source[`${sourceType}Id`]; // Dynamically get groupId, roomId, or userId

  console.log(`Received message: "${messageText}" from user ${userId} in ${sourceType} ${sourceId}`);

  let isCommand = false;
  let replyText = '';

  // --- Command Handling ---
  // Group/Room command: @TranslatorBot language [lang]
  if (messageText.toLowerCase().startsWith('@translatorbot language') && (sourceType === 'group' || sourceType === 'room')) {
    isCommand = true;
    const parts = messageText.split(' ');
    if (parts.length >= 3) {
      const lang = parts.slice(2).join(' ').trim().toLowerCase(); // Handle multi-word languages
      if (lang) {
        if (!groupPreferences[sourceId]) {
          groupPreferences[sourceId] = {}; // Ensure group/room exists in prefs
        }
        groupPreferences[sourceId][userId] = lang;
        replyText = `OK! Your preferred language is set to ${lang} for this ${sourceType}.`;
        console.log(`Set language for user ${userId} in ${sourceType} ${sourceId} to ${lang}`);
      } else {
        replyText = "Please specify a language after 'language'. Example: @TranslatorBot language French";
      }
    } else {
      replyText = "Invalid command format. Use: @TranslatorBot language [language name or code]";
    }
    // Reply to the command
    try {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: replyText }] });
    } catch (error) {
        console.error("Failed to reply to command:", error.response ? error.response.data : error.message);
    }

  }
  // User (1-on-1) command: language [lang]
  else if (messageText.toLowerCase().startsWith('language') && sourceType === 'user') {
     isCommand = true;
     const parts = messageText.split(' ');
     if (parts.length >= 2) {
       const lang = parts.slice(1).join(' ').trim().toLowerCase();
       if (lang) {
         userPreferences[userId] = lang;
         replyText = `OK! Your preferred language is set to ${lang}.`;
         console.log(`Set language for user ${userId} (direct) to ${lang}`);
       } else {
         replyText = "Please specify a language after 'language'. Example: language Japanese";
       }
     } else {
       replyText = "Invalid command format. Use: language [language name or code]";
     }
     // Reply to the command
     try {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: replyText }] });
     } catch (error) {
        console.error("Failed to reply to command:", error.response ? error.response.data : error.message);
     }
  }

  // --- Translation Logic (Only if not a command and in a group/room) ---
  if (!isCommand && (sourceType === 'group' || sourceType === 'room')) {
    // Fetch target languages needed for this group/room
    const targetLangs = getTargetLanguages(sourceId, userId);

    if (targetLangs.size === 0) {
      console.log("No target languages needed for translation.");
      return null; // Nothing to translate
    }

    // Get translations concurrently
    const translationPromises = Array.from(targetLangs).map(async (langCode) => {
        const translation = await translateText(messageText, langCode);
        return { lang: langCode, text: translation }; // Return object with lang and text
    });

    const results = await Promise.all(translationPromises);

    // Filter out failed translations and format successful ones
    const successfulTranslations = results.filter(result => result.text !== null);

    if (successfulTranslations.length > 0) {
      const senderName = await getUserProfile(userId); // Get sender's name
      const originalMessageLine = `Original message from ${senderName}:\n${messageText}\n`;
      const translationLines = ["\n--- Translations ---"];
      successfulTranslations.forEach(result => {
        translationLines.push(`${result.lang.toUpperCase()}: ${result.text}`);
      });

      let fullReplyText = originalMessageLine + translationLines.join('\n');

      // Ensure message length is within LINE limits (5000 characters)
      if (fullReplyText.length > 5000) {
        fullReplyText = fullReplyText.substring(0, 4997) + "...";
        console.warn("Trimmed translation message due to length limit.");
      }

      // Use Push API to send translations to the group/room
      try {
        await lineClient.pushMessage({
          to: sourceId, // Send to the group/room ID
          messages: [{ type: 'text', text: fullReplyText }],
        });
        console.log(`Sent translations to ${sourceType} ${sourceId}`);
      } catch (error) {
        console.error(`Failed to push translation message to ${sourceType} ${sourceId}:`, error.response ? error.response.data : error.message);
      }
    } else {
      console.log("No successful translations were generated.");
    }
  }

  return null; // Indicate event processed (or ignored)
}

// --- Start Server ---
// This is mainly for local testing. Vercel runs the file differently.
if (process.env.NODE_ENV !== 'production') { // Only run listen locally
    app.listen(port, () => {
        console.log(`Local server running on http://localhost:${port}`);
        console.log('Make sure your LINE Webhook URL is configured for /callback');
    });
}

// Export the app for Vercel
export default app;

