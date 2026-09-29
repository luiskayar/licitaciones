import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import FormData from 'form-data';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 1. Identificar el archivo JSON más reciente
const resultsDir = path.join(__dirname, '../data/results');
const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).sort();
const latestFile = files[files.length - 1];

if (!latestFile) {
    console.log('No se encontraron archivos JSON de licitaciones.');
    process.exit(0);
}

const licitaciones = JSON.parse(fs.readFileSync(path.join(resultsDir, latestFile), 'utf-8'));

// 2. Crear el PDF
const doc = new PDFDocument();
const pdfPath = path.join(__dirname, '../data/reporte_temp.pdf');
const stream = fs.createWriteStream(pdfPath);
doc.pipe(stream);

doc.fontSize(20).text(`Reporte de Licitaciones`, { align: 'center' });
doc.fontSize(12).text(`Archivo origen: ${latestFile}`, { align: 'center' });
doc.moveDown();

licitaciones.forEach(lic => {
    doc.fontSize(14).fillColor('black').text(lic.titulo || 'Sin título');
    doc.fontSize(10).fillColor('gray').text(`Portal: ${lic.portal} | Fecha de cierre: ${lic.fechaCierre || 'N/A'}`);
    doc.fontSize(10).fillColor('blue').text(`Relevancia IA: ${lic.relevancia || 'N/A'}`);
    doc.moveDown();
});
doc.end();

// 3. Enviar el PDF a n8n imitando el código de Luis
stream.on('finish', async () => {
    try {
        const nombreDinamico = `Licitaciones_${latestFile.replace('.json', '.pdf')}`;
        const stats = fs.statSync(pdfPath);
        
        const form = new FormData();
        
        // Copiamos EXACTAMENTE la estructura que Luis usa en su route.ts
        form.append('data', fs.createReadStream(pdfPath), { filename: nombreDinamico });
        form.append('fileName', nombreDinamico);
        form.append('fileSize', String(stats.size));
        form.append('uploadedAt', new Date().toISOString());

        const n8nWebhookUrl = 'https://delphos.deinsa.com:5678/webhook/licitaciones'; 

        console.log(`Enviando ${nombreDinamico} a n8n...`);
        
        const response = await axios.post(n8nWebhookUrl, form, {
            headers: {
                ...form.getHeaders(),
                // Agregamos un User-Agent para evitar que el firewall de Deinsa bloquee a Axios con un 401
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        console.log('¡Reporte entregado a n8n con éxito! Status:', response.status);
        
    } catch (error) {
        // Mejoramos el manejo de errores para ver exactamente qué rechaza el servidor
        console.error('Error enviando a n8n:');
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error('Respuesta del servidor:', error.response.data);
        } else {
            console.error(error.message);
        }
        process.exit(1);
    }
}); 