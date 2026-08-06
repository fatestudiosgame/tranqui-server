// server.js (con logs mejorados)
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

// --- Cargar la clave de servicio ---
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Clave de servicio cargada desde variable de entorno');
  } catch (e) {
    console.error('❌ Error al parsear FIREBASE_SERVICE_ACCOUNT:', e.message);
    process.exit(1);
  }
} else {
  try {
    const keyPath = './firebase-key.json';
    if (!fs.existsSync(keyPath)) {
      console.error('❌ No se encuentra el archivo firebase-key.json');
      process.exit(1);
    }
    serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    console.log('✅ Clave de servicio cargada desde firebase-key.json');
  } catch (e) {
    console.error('❌ Error al leer firebase-key.json:', e.message);
    process.exit(1);
  }
}

// --- Inicializar Firebase Admin ---
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin inicializado correctamente');
} catch (e) {
  console.error('❌ Error al inicializar Firebase Admin:', e.message);
  process.exit(1);
}

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========== RUTAS DE LA API ==========

// 1. Obtener todos los negocios
app.get('/api/negocios', async (req, res) => {
  console.log('📡 Recibida petición GET /api/negocios');
  try {
    console.log('🔍 Consultando Firestore...');
    const snapshot = await db.collection('negocios').get();
    console.log(`📦 Documentos encontrados: ${snapshot.docs.length}`);

    if (snapshot.docs.length === 0) {
      console.log('⚠️ No se encontraron documentos en la colección "negocios"');
      return res.json({ success: true, data: [] });
    }

    const negocios = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      console.log(`📄 Documento ID: ${doc.id}`, data);
      // Verificar campos esperados
      if (!data.descripcion || data.latitud === undefined || data.longitud === undefined) {
        console.log(`⚠️ Documento ${doc.id} tiene campos faltantes:`, data);
      }
      negocios.push({
        id: doc.id,
        ...data
      });
    });

    console.log(`✅ Devolviendo ${negocios.length} negocios`);
    res.json({ success: true, data: negocios });
  } catch (error) {
    console.error('❌ Error al obtener negocios:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocios',
      error: error.message
    });
  }
});

// 2. Agregar un nuevo negocio
app.post('/api/negocios', async (req, res) => {
  console.log('📡 Recibida petición POST /api/negocios');
  try {
    const { descripcion, latitud, longitud } = req.body;
    console.log(`📝 Agregando: "${descripcion}" (${latitud}, ${longitud})`);

    if (!descripcion || latitud === undefined || longitud === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Faltan campos: descripcion, latitud, longitud'
      });
    }

    const docRef = await db.collection('negocios').add({
      descripcion,
      latitud: parseFloat(latitud),
      longitud: parseFloat(longitud),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Negocio agregado con ID: ${docRef.id}`);
    res.status(201).json({
      success: true,
      message: 'Negocio agregado correctamente',
      id: docRef.id
    });
  } catch (error) {
    console.error('❌ Error al agregar negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar negocio',
      error: error.message
    });
  }
});

// 3. Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`✅ Servidor proxy de Tranqui corriendo en http://localhost:${port}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /api/negocios`);
  console.log(`   POST /api/negocios`);
  console.log(`   GET  /api/health`);
});