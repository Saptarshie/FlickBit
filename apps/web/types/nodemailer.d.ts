declare module 'nodemailer' {
  export interface SendMailOptions {
    to: string;
    from?: string;
    subject: string;
    text: string;
    html?: string;
  }

  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<unknown>;
  }

  export function createTransport(server: string | object): Transporter;

  interface Nodemailer {
    createTransport: typeof createTransport;
  }

  const nodemailer: Nodemailer;
  export default nodemailer;
}
