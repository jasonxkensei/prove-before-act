import jsPDF from "jspdf";
import QRCode from "qrcode";

export interface ProofPDFData {
  fileName: string;
  fileHash: string;
  txHash: string;
  explorerUrl: string;
  authorName: string;
  certificationDate: string;
}

export async function generateProofPDF(data: ProofPDFData): Promise<void> {
  const doc = new jsPDF();
  
  const qrCodeDataUrl = await QRCode.toDataURL(data.explorerUrl, {
    width: 150,
    margin: 1,
  });

  const primaryColor = [16, 185, 129];
  const textColor = [31, 41, 55];
  
  doc.setFillColor(primaryColor[0], primaryColor[1], primaryColor[2]);
  doc.rect(0, 0, 210, 40, 'F');
  
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(28);
  doc.text("Prove Before Act", 20, 25);
  
  doc.setFontSize(12);
  doc.text("Blockchain Certificate of Authenticity", 20, 33);
  
  doc.setTextColor(textColor[0], textColor[1], textColor[2]);
  doc.setFontSize(16);
  doc.text("File Certification", 20, 55);
  
  doc.setFontSize(11);
  doc.text(`File Name:`, 20, 70);
  doc.setFont("helvetica", 'bold');
  doc.text(data.fileName, 50, 70);
  
  doc.setFont("helvetica", 'normal');
  doc.text(`Author:`, 20, 80);
  doc.setFont("helvetica", 'bold');
  doc.text(data.authorName, 50, 80);
  
  doc.setFont("helvetica", 'normal');
  doc.text(`Certification Date:`, 20, 90);
  doc.setFont("helvetica", 'bold');
  doc.text(data.certificationDate, 50, 90);
  
  doc.setFont("helvetica", 'normal');
  doc.setFontSize(12);
  doc.text("SHA-256 Hash:", 20, 105);
  doc.setFontSize(9);
  doc.setFont("helvetica", 'bold');
  doc.text(data.fileHash, 20, 112);
  
  doc.setFont("helvetica", 'normal');
  doc.setFontSize(12);
  doc.text("MultiversX Transaction Hash:", 20, 125);
  doc.setFontSize(9);
  doc.setFont("helvetica", 'bold');
  doc.text(data.txHash, 20, 132);
  
  doc.addImage(qrCodeDataUrl, "PNG", 150, 100, 40, 40);
  doc.setFontSize(8);
  doc.setFont("helvetica", 'normal');
  doc.text("Scan to verify", 158, 145);
  
  doc.setDrawColor(200, 200, 200);
  doc.line(20, 155, 190, 155);
  
  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.text("How to Verify:", 20, 165);
  doc.setFontSize(9);
  doc.text("1. Scan the QR code or visit the MultiversX Explorer URL", 25, 173);
  doc.text("2. Verify the transaction hash matches the one above", 25, 180);
  doc.text("3. Check the transaction data contains the file hash", 25, 187);
  
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  doc.text("This certificate proves the existence of this file at the specified time on MultiversX blockchain.", 20, 200);
  
  const pdfFileName = `${data.fileName.replace(/\.[^/.]+$/, "")}_pba_certificate.pdf`;
  doc.save(pdfFileName);
}
