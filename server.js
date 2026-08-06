// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const dotenv = require('dotenv');

// Cargar variables de entorno
dotenv.config();

// --- Cargar la clave de servicio ---
let serviceAccount;

// Si estamos en producción (Render), usamos variable de entorno
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Clave de servicio cargada desde variable de entorno');
  } catch (e) {
    console.error('❌ Error al parsear FIREBASE_SERVICE_ACCOUNT:', e.message);
    process.exit(1);
  }
} else {
  // En desarrollo local, leemos el archivo firebase-key.json
  try {
    const keyPath = './firebase-key.json';
    if (!fs.existsSync(keyPath)) {
      console.error('❌ No se encuentra el archivo firebase-key.json');
      console.error('   Descárgalo desde Firebase Console y colócalo aquí.');
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

// --- Crear la app Express ---
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ========== RUTAS DE LA API ==========

/**
 * GET /api/negocios
 * Devuelve la lista de todos los negocios ordenados por timestamp (más reciente primero)
 */
app.get('/api/negocios', async (req, res) => {
  console.log('📡 Recibida petición GET /api/negocios');
  try {
    const snapshot = await db.collection('negocios')
      .orderBy('timestamp', 'desc')
      .get();

    const negocios = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      negocios.push({
        id: doc.id,
        ...data
      });
    });

    console.log(`✅ Devolviendo ${negocios.length} negocios`);
    res.json({
      success: true,
      data: negocios
    });
  } catch (error) {
    console.error('❌ Error al obtener negocios:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocios',
      error: error.message
    });
  }
});

/**
 * POST /api/negocios
 * Agrega un nuevo negocio con los campos: nombre, descripcion, latitud, longitud, horario (opcional)
 */
app.post('/api/negocios', async (req, res) => {
  console.log('📡 Recibida petición POST /api/negocios');
  try {
    const { nombre, descripcion, latitud, longitud, horario } = req.body;

    console.log(`📝 Datos recibidos:`, { nombre, descripcion, latitud, longitud, horario });

    // Validar campos obligatorios
    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'El nombre del negocio es obligatorio'
      });
    }
    if (latitud === undefined || longitud === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Faltan coordenadas (latitud, longitud)'
      });
    }

    // Crear el objeto a guardar en Firestore
    const negocioData = {
      nombre: nombre.trim(),
      descripcion: descripcion ? descripcion.trim() : '',
      latitud: parseFloat(latitud),
      longitud: parseFloat(longitud),
      horario: horario ? horario.trim() : '',
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

/**
 * GET /api/negocios/:id
 * Obtiene un negocio específico por su ID
 */
app.get('/api/negocios/:id', async (req, res) => {
  try {
    const doc = await db.collection('negocios').doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Negocio no encontrado'
      });
    }
    res.json({
      success: true,
      data: {
        id: doc.id,
        ...doc.data()
      }
    });
  } catch (error) {
    console.error('Error al obtener negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocio',
      error: error.message
    });
  }
});

/**
 * GET /api/health
 * Health check para saber si el servidor está vivo
 */
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
  console.log(`📡 Endpoints disponibles:`);
  console.log(`   GET  /api/negocios       - Obtener todos los negocios`);
  console.log(`   POST /api/negocios       - Agregar un nuevo negocio`);
  console.log(`   GET  /api/negocios/:id   - Obtener un negocio específico`);
  console.log(`   GET  /api/health         - Verificar estado del servidor`);
});