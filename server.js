const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

// --- Cargar clave de servicio ---
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
      console.error('❌ No se encuentra firebase-key.json');
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

// ========== RUTAS PARA NEGOCIOS ==========
app.get('/api/negocios', async (req, res) => {
  console.log('📡 GET /api/negocios');
  try {
    const snapshot = await db.collection('negocios').orderBy('timestamp', 'desc').get();
    const negocios = [];
    snapshot.forEach(doc => {
      negocios.push({ id: doc.id, ...doc.data() });
    });
    console.log(`✅ Devolviendo ${negocios.length} negocios`);
    res.json({ success: true, data: negocios });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocios',
      error: error.message
    });
  }
});

app.post('/api/negocios', async (req, res) => {
  console.log('📡 POST /api/negocios');
  try {
    const { nombre, descripcion, latitud, longitud } = req.body;
    console.log('📝 Datos recibidos:', { nombre, descripcion, latitud, longitud });
    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({ success: false, message: 'El nombre es obligatorio' });
    }
    if (latitud === undefined || longitud === undefined) {
      return res.status(400).json({ success: false, message: 'Faltan coordenadas' });
    }
    const negocioData = {
      nombre: nombre.trim(),
      descripcion: descripcion ? descripcion.trim() : '',
      latitud: parseFloat(latitud),
      longitud: parseFloat(longitud),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    const docRef = await db.collection('negocios').add(negocioData);
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

app.get('/api/negocios/:id', async (req, res) => {
  try {
    const doc = await db.collection('negocios').doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Negocio no encontrado' });
    }
    res.json({ success: true, data: { id: doc.id, ...doc.data() } });
  } catch (error) {
    console.error('Error al obtener negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocio',
      error: error.message
    });
  }
});

// ========== RUTAS PARA REPORTES DE LUZ ==========
app.get('/api/reportes-luz', async (req, res) => {
  console.log('📡 GET /api/reportes-luz');
  try {
    const ahora = new Date();
    const limite = new Date(ahora.getTime() - 2 * 60 * 60 * 1000);
    const snapshot = await db.collection('reportes_luz')
      .where('timestamp', '>=', limite)
      .orderBy('timestamp', 'desc')
      .get();
    const reportes = [];
    snapshot.forEach(doc => {
      reportes.push({ id: doc.id, ...doc.data() });
    });
    console.log(`✅ Devolviendo ${reportes.length} reportes de luz`);
    res.json({ success: true, data: reportes });
  } catch (error) {
    console.error('❌ Error al obtener reportes de luz:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener reportes de luz',
      error: error.message
    });
  }
});

app.post('/api/reportes-luz', async (req, res) => {
  console.log('📡 POST /api/reportes-luz');
  try {
    const { latitud, longitud, estado } = req.body;
    console.log('📝 Datos recibidos:', { latitud, longitud, estado });
    if (latitud === undefined || longitud === undefined || estado === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Faltan campos: latitud, longitud, estado'
      });
    }
    const reporteData = {
      latitud: parseFloat(latitud),
      longitud: parseFloat(longitud),
      estado: estado === true || estado === 'true' ? true : false,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    const docRef = await db.collection('reportes_luz').add(reporteData);
    console.log(`✅ Reporte de luz guardado con ID: ${docRef.id} (estado: ${reporteData.estado})`);
    res.status(201).json({
      success: true,
      message: 'Reporte guardado correctamente',
      id: docRef.id
    });
  } catch (error) {
    console.error('❌ Error al guardar reporte de luz:', error);
    res.status(500).json({
      success: false,
      message: 'Error al guardar reporte de luz',
      error: error.message
    });
  }
});

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ========== INICIAR SERVIDOR ==========
app.listen(port, () => {
  console.log(`✅ Servidor proxy de Tranqui corriendo en http://localhost:${port}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /api/negocios`);
  console.log(`   POST /api/negocios`);
  console.log(`   GET  /api/negocios/:id`);
  console.log(`   GET  /api/reportes-luz`);
  console.log(`   POST /api/reportes-luz`);
  console.log(`   GET  /api/health`);
});