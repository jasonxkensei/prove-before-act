import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type { Certification } from "@shared/schema";

interface CertificateOptions {
  certification: Certification;
  subscriptionTier: string;
  companyName?: string;
  companyLogoUrl?: string;
  signerAddress?: string;
}

const COLORS = {
  primary: '#059669',
  primaryDark: '#047857',
  primaryLight: '#10b981',
  gold: '#d4af37',
  goldLight: '#f0d78c',
  text: '#1f2937',
  textLight: '#6b7280',
  textMuted: '#9ca3af',
  border: '#e5e7eb',
  background: '#f9fafb',
  white: '#ffffff',
  black: '#000000',
};

function drawSecurityPattern(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number) {
  doc.save();
  doc.rect(x, y, width, height).clip();
  
  doc.strokeColor(COLORS.primaryLight).strokeOpacity(0.08).lineWidth(0.5);
  for (let i = 0; i < width + height; i += 8) {
    doc.moveTo(x + i, y).lineTo(x, y + i).stroke();
    doc.moveTo(x + width - i, y).lineTo(x + width, y + i).stroke();
  }
  
  doc.restore();
}

function drawOfficialSeal(doc: PDFKit.PDFDocument, centerX: number, centerY: number, radius: number) {
  doc.save();
  
  doc.circle(centerX, centerY, radius).fillOpacity(0.1).fill(COLORS.gold);
  doc.circle(centerX, centerY, radius - 3).lineWidth(2).strokeColor(COLORS.gold).stroke();
  doc.circle(centerX, centerY, radius - 8).lineWidth(1).strokeColor(COLORS.gold).stroke();
  
  doc.fillOpacity(1).fillColor(COLORS.gold);
  const points = 12;
  for (let i = 0; i < points; i++) {
    const angle = (i * 2 * Math.PI) / points - Math.PI / 2;
    const innerRadius = radius - 20;
    const outerRadius = radius - 12;
    const x1 = centerX + Math.cos(angle) * innerRadius;
    const y1 = centerY + Math.sin(angle) * innerRadius;
    const x2 = centerX + Math.cos(angle) * outerRadius;
    const y2 = centerY + Math.sin(angle) * outerRadius;
    doc.circle((x1 + x2) / 2, (y1 + y2) / 2, 2).fill(COLORS.gold);
  }
  
  doc.fontSize(7).font('Helvetica-Bold').fillColor(COLORS.primaryDark);
  doc.text('CERTIFIED', centerX - 22, centerY - 18, { width: 44, align: 'center' });
  doc.text('AUTHENTIC', centerX - 22, centerY + 8, { width: 44, align: 'center' });
  
  doc.fontSize(14).text('✓', centerX - 6, centerY - 6);
  
  doc.restore();
}

function formatDate(date: Date | string | null | undefined): string {
  const d = date ? new Date(date) : new Date();
  return d.toLocaleDateString('en-US', { 
    year: 'numeric',
    month: 'long', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

function generateCertificateNumber(certification: Certification): string {
  const date = new Date(certification.createdAt || new Date());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  
  // Generate a deterministic 6-digit number from the UUID using djb2 hash algorithm
  const id = String(certification.id);
  let hash = 5381; // djb2 magic constant
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = Math.imul(hash, 33) + char;
    hash = hash >>> 0; // Convert to unsigned 32-bit integer
  }
  const numericId = hash % 1000000;
  const idPart = String(numericId).padStart(6, '0');
  
  return `PM-${year}${month}-${idPart}`;
}

export async function generateCertificatePDF(options: CertificateOptions): Promise<Buffer> {
  const { certification, subscriptionTier, companyName, signerAddress } = options;
  
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        size: 'A4', 
        margin: 0,
        info: {
          Title: `Prove Before Act Certificate - ${certification.fileName}`,
          Author: 'Prove Before Act',
          Subject: 'Blockchain Proof of Ownership Certificate',
          Keywords: 'blockchain, certificate, proof, ownership, multiversx',
          Creator: 'Prove Before Act Certification Platform'
        }
      });
      
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const margin = 40;
      const contentWidth = pageWidth - (margin * 2);
      
      const certificateNumber = generateCertificateNumber(certification);
      const explorerUrl = certification.transactionHash ? `https://explorer.multiversx.com/transactions/${certification.transactionHash}` : null;
      const qrTarget = explorerUrl || 'https://explorer.multiversx.com';
      const qrCodeDataUrl = await QRCode.toDataURL(qrTarget, { 
        width: 200, 
        margin: 1,
        color: { dark: COLORS.primaryDark, light: '#ffffff' }
      });

      doc.rect(0, 0, pageWidth, pageHeight).fill(COLORS.white);
      
      doc.rect(margin - 5, margin - 5, contentWidth + 10, pageHeight - (margin * 2) + 10)
         .lineWidth(3)
         .strokeColor(COLORS.primary)
         .stroke();
      
      doc.rect(margin, margin, contentWidth, pageHeight - (margin * 2))
         .lineWidth(1)
         .strokeColor(COLORS.gold)
         .stroke();
      
      doc.rect(margin + 5, margin + 5, contentWidth - 10, pageHeight - (margin * 2) - 10)
         .lineWidth(0.5)
         .strokeColor(COLORS.border)
         .stroke();

      drawSecurityPattern(doc, margin + 8, margin + 8, contentWidth - 16, 80);

      let yPos = margin + 25;

      doc.fontSize(10).font('Helvetica').fillColor(COLORS.textMuted);
      doc.text(certificateNumber, margin + 20, yPos, { width: 150 });
      
      doc.text(formatDate(certification.createdAt).split(',')[0], pageWidth - margin - 120, yPos, { 
        width: 100, 
        align: 'right' 
      });

      yPos += 30;

      doc.fontSize(32).font('Helvetica-Bold').fillColor(COLORS.primary);
      doc.text('XPROOF', margin, yPos, { width: contentWidth, align: 'center' });
      
      yPos += 38;
      
      doc.fontSize(9).font('Helvetica').fillColor(COLORS.textLight);
      doc.text('BLOCKCHAIN CERTIFICATION PLATFORM', margin, yPos, { 
        width: contentWidth, 
        align: 'center',
        characterSpacing: 3
      });

      yPos += 35;
      
      doc.moveTo(margin + 100, yPos).lineTo(pageWidth - margin - 100, yPos)
         .lineWidth(2).strokeColor(COLORS.gold).stroke();
      doc.moveTo(margin + 120, yPos + 4).lineTo(pageWidth - margin - 120, yPos + 4)
         .lineWidth(0.5).strokeColor(COLORS.goldLight).stroke();

      yPos += 30;

      doc.fontSize(22).font('Helvetica-Bold').fillColor(COLORS.text);
      doc.text('CERTIFICATE OF AUTHENTICITY', margin, yPos, { 
        width: contentWidth, 
        align: 'center' 
      });

      yPos += 35;
      
      doc.fontSize(11).font('Helvetica').fillColor(COLORS.textLight);
      doc.text('This document certifies that the digital file described below has been', margin, yPos, { 
        width: contentWidth, 
        align: 'center' 
      });
      yPos += 16;
      doc.text('cryptographically recorded on the MultiversX blockchain, establishing an', margin, yPos, { 
        width: contentWidth, 
        align: 'center' 
      });
      yPos += 16;
      doc.text('immutable and verifiable proof of existence and ownership.', margin, yPos, { 
        width: contentWidth, 
        align: 'center' 
      });

      yPos += 40;

      const boxMargin = margin + 25;
      const boxWidth = contentWidth - 50;
      const boxHeight = 215;
      
      doc.roundedRect(boxMargin, yPos, boxWidth, boxHeight, 5)
         .fillOpacity(0.03).fill(COLORS.primary);
      doc.roundedRect(boxMargin, yPos, boxWidth, boxHeight, 5)
         .lineWidth(1).strokeColor(COLORS.primary).strokeOpacity(0.3).stroke();

      let infoY = yPos + 18;
      const labelX = boxMargin + 20;
      const valueX = boxMargin + 130;
      const valueWidth = boxWidth - 160;

      doc.fillOpacity(1).strokeOpacity(1);
      
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.textLight);
      doc.text('DOCUMENT NAME', labelX, infoY);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(COLORS.text);
      doc.text(certification.fileName, valueX, infoY - 1, { width: valueWidth });

      infoY += 32;
      
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.textLight);
      doc.text('SHA-256 FINGERPRINT', labelX, infoY);
      doc.fontSize(8).font('Courier').fillColor(COLORS.text);
      const hash = certification.fileHash;
      doc.text(hash.substring(0, 32), valueX, infoY - 1, { width: valueWidth });
      doc.text(hash.substring(32), valueX, infoY + 10, { width: valueWidth });

      infoY += 38;
      
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.textLight);
      doc.text('CERTIFICATION DATE', labelX, infoY);
      doc.fontSize(10).font('Helvetica').fillColor(COLORS.text);
      doc.text(formatDate(certification.createdAt), valueX, infoY - 1, { width: valueWidth });

      infoY += 32;

      // CERTIFIED BY: show agent name if meaningful, otherwise fall back to wallet address
      const certifiedByValue =
        certification.authorName && certification.authorName !== 'AI Agent'
          ? certification.authorName
          : signerAddress ?? certification.authorName ?? 'Unknown';
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.textLight);
      doc.text('CERTIFIED BY', labelX, infoY);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(COLORS.text);
      doc.text(certifiedByValue, valueX, infoY - 1, { width: valueWidth });

      infoY += 32;

      // PUBLIC PROOF LINK
      const proofUrl = `https://provebeforeact.com/proof/${certification.id}`;
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.textLight);
      doc.text('PUBLIC PROOF', labelX, infoY);
      doc.fontSize(9).font('Helvetica').fillColor(COLORS.primary);
      doc.text(proofUrl, valueX, infoY - 1, { width: valueWidth, link: proofUrl, underline: true });

      yPos += boxHeight + 30;

      doc.fontSize(12).font('Helvetica-Bold').fillColor(COLORS.primary);
      doc.text('BLOCKCHAIN VERIFICATION', margin, yPos, { width: contentWidth, align: 'center' });
      
      yPos += 25;
      
      const verifyBoxWidth = (contentWidth - 40) / 2;
      const leftBoxX = margin + 15;
      const rightBoxX = margin + verifyBoxWidth + 25;
      
      doc.roundedRect(leftBoxX, yPos, verifyBoxWidth, 130, 3)
         .lineWidth(0.5).strokeColor(COLORS.border).stroke();
      
      doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.textLight);
      doc.text('TRANSACTION HASH', leftBoxX + 10, yPos + 12);
      
      if (certification.transactionHash) {
        doc.fontSize(7).font('Courier').fillColor(COLORS.text);
        const txHash = certification.transactionHash;
        const chunkSize = Math.ceil(txHash.length / 4);
        let txY = yPos + 28;
        for (let i = 0; i < txHash.length; i += chunkSize) {
          doc.text(txHash.substring(i, i + chunkSize), leftBoxX + 10, txY, { width: verifyBoxWidth - 20 });
          txY += 12;
        }
      }
      
      doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.textLight);
      doc.text('NETWORK', leftBoxX + 10, yPos + 85);
      doc.fontSize(9).font('Helvetica').fillColor(COLORS.primary);
      doc.text('MultiversX Mainnet', leftBoxX + 10, yPos + 100);
      
      if (explorerUrl) {
        doc.fontSize(8).font('Helvetica').fillColor(COLORS.primary);
        doc.text('View on Explorer', leftBoxX + 10, yPos + 115, { 
          link: explorerUrl,
          underline: true 
        });
      }
      
      doc.roundedRect(rightBoxX, yPos, verifyBoxWidth, 130, 3)
         .lineWidth(0.5).strokeColor(COLORS.border).stroke();
      
      const qrImage = Buffer.from(qrCodeDataUrl.split(',')[1], 'base64');
      const qrSize = 85;
      const qrX = rightBoxX + (verifyBoxWidth - qrSize) / 2;
      doc.image(qrImage, qrX, yPos + 10, { width: qrSize, height: qrSize });
      
      doc.fontSize(8).font('Helvetica').fillColor(COLORS.textMuted);
      doc.text('Scan to view on Explorer', rightBoxX, yPos + 100, { width: verifyBoxWidth, align: 'center' });

      yPos += 145;

      drawOfficialSeal(doc, pageWidth - margin - 60, yPos + 20, 35);

      if (subscriptionTier === 'business' && companyName) {
        doc.fontSize(10).font('Helvetica-Bold').fillColor(COLORS.text);
        doc.text('Certified by:', margin + 30, yPos + 5);
        doc.fontSize(12).fillColor(COLORS.primary);
        doc.text(companyName, margin + 30, yPos + 20);
      }

      const footerY = pageHeight - margin - 50;
      
      doc.moveTo(margin + 50, footerY - 10).lineTo(pageWidth - margin - 50, footerY - 10)
         .lineWidth(0.5).strokeColor(COLORS.border).stroke();
      
      doc.fontSize(8).font('Helvetica').fillColor(COLORS.textMuted);
      doc.text('This certificate is cryptographically secured and independently verifiable on the MultiversX blockchain.', 
               margin, footerY, { width: contentWidth, align: 'center' });
      doc.text('Any modification to the original document will result in a different hash, invalidating this certificate.',
               margin, footerY + 12, { width: contentWidth, align: 'center' });
      
      doc.fontSize(7).fillColor(COLORS.textMuted);
      doc.text('Prove Before Act © ' + new Date().getFullYear() + ' — Blockchain Certification Platform — provebeforeact.com',
               margin, footerY + 30, { width: contentWidth, align: 'center' });

      if (subscriptionTier === 'free') {
        doc.fontSize(7).fillColor(COLORS.textMuted);
        doc.text('Free Tier Certificate', margin + 10, pageHeight - margin - 10);
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
