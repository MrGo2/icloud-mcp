/**
 * SMTP client wrapper for sending iCloud Mail
 */

const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('../config');
const { getCredentials } = require('../auth');
const imapClient = require('./imap-client');

/**
 * Resolve the From: header. Defaults to the authenticating Apple ID; an
 * override must be an address verified on that same account or iCloud's
 * SMTP rejects the message at submission time.
 */
function resolveFrom() {
  const address = config.FROM.ADDRESS || getCredentials().email;
  return config.FROM.NAME ? { name: config.FROM.NAME, address } : address;
}

/**
 * Create SMTP transporter
 */
function createTransporter() {
  const creds = getCredentials();

  return nodemailer.createTransport({
    host: config.SMTP.HOST,
    port: config.SMTP.PORT,
    secure: config.SMTP.SECURE,
    auth: {
      user: creds.email,
      pass: creds.password
    }
  });
}

/**
 * Send an email
 */
async function sendEmail({ to, cc, bcc, subject, body, isHtml = false }) {
  const transporter = createTransporter();

  const mailOptions = {
    from: resolveFrom(),
    to,
    subject,
    [isHtml ? 'html' : 'text']: body
  };

  if (cc) mailOptions.cc = cc;
  if (bcc) mailOptions.bcc = bcc;

  // Compile the MIME message once and transmit that exact bytes, so the copy
  // filed in Sent is identical to what the recipient got (same Message-ID)
  // rather than a recomposed near-duplicate.
  const raw = await new MailComposer(mailOptions).compile().build();
  const messageIdMatch = raw.toString().match(/^Message-ID:\s*(<[^>]+>)/im);

  // A raw message carries no envelope of its own, so state it explicitly.
  const fromAddress = typeof mailOptions.from === 'string'
    ? mailOptions.from
    : mailOptions.from.address;
  const envelope = {
    from: fromAddress,
    to: [to, cc, bcc]
      .filter(Boolean)
      .join(',')
      .split(',')
      .map((addr) => addr.trim())
      .filter(Boolean)
  };

  try {
    const info = await transporter.sendMail({ envelope, raw });

    // Best-effort: a failed APPEND must not be reported as a failed send,
    // because the message has already left. Surface it instead.
    let savedToSent = false;
    let saveToSentError = null;
    if (config.SAVE_TO_SENT) {
      try {
        await imapClient.appendToFolder(raw, 'sent');
        savedToSent = true;
      } catch (err) {
        saveToSentError = err.message;
      }
    }

    return {
      success: true,
      messageId: (messageIdMatch && messageIdMatch[1]) || info.messageId,
      from: typeof mailOptions.from === 'string' ? mailOptions.from : mailOptions.from.address,
      accepted: info.accepted,
      rejected: info.rejected,
      savedToSent,
      saveToSentError
    };
  } catch (error) {
    if (error.message?.includes('auth') || error.code === 'EAUTH') {
      throw new Error('UNAUTHORIZED');
    }
    throw error;
  }
}

/**
 * Verify SMTP connection
 */
async function verifyConnection() {
  const transporter = createTransporter();

  try {
    await transporter.verify();
    return true;
  } catch (error) {
    if (error.message?.includes('auth') || error.code === 'EAUTH') {
      throw new Error('UNAUTHORIZED');
    }
    throw error;
  }
}

module.exports = {
  sendEmail,
  verifyConnection
};
