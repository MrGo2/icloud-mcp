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
    // Fixed here so the Sent copy, built separately when there is a Bcc, gets
    // the identical Date header.
    date: new Date(),
    to,
    subject,
    [isHtml ? 'html' : 'text']: body
  };

  if (cc) mailOptions.cc = cc;
  if (bcc) mailOptions.bcc = bcc;

  // Compile the MIME message once and transmit exactly those bytes. A raw
  // message carries no envelope, so take it from the compiled node: MailComposer
  // has already parsed the address lists (quoted display names containing
  // commas included) and folded Bcc into the envelope without leaving a Bcc:
  // header in the transmitted bytes.
  const compiled = new MailComposer(mailOptions).compile();
  const envelope = compiled.getEnvelope();
  const messageId = compiled.messageId();
  const raw = await compiled.build();

  // The copy filed in Sent shares the Message-ID and Date of what was sent.
  // It differs only by keeping the Bcc: header, so Sent shows who was blind-
  // copied; the transmitted message never carries it.
  let sentCopy = raw;
  if (bcc) {
    const withBcc = new MailComposer({ ...mailOptions, messageId }).compile();
    withBcc.keepBcc = true;
    sentCopy = await withBcc.build();
  }

  try {
    const info = await transporter.sendMail({ envelope, raw });

    // Best-effort: a failed APPEND must not be reported as a failed send,
    // because the message has already left. Surface it instead.
    let savedToSent = false;
    let saveToSentError = null;
    if (config.SAVE_TO_SENT) {
      try {
        await imapClient.appendToFolder(sentCopy, 'sent');
        savedToSent = true;
      } catch (err) {
        saveToSentError = err.message;
      }
    }

    return {
      success: true,
      messageId: messageId || info.messageId,
      from: envelope.from,
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
