import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory file upload using Multer
const upload = multer({ storage: multer.memoryStorage() });

if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️  WARNING: GEMINI_API_KEY is not set in environment variables.');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// In-memory state holding the deterministically calculated results
let currentAnalytics = null;

// ==========================================
// DETERMINISTIC CALCULATION ENGINE
// ==========================================
function computeDeterministicAnalytics(ordersRows, ledgerRows) {
  // 1. DELIVERY VARIABLES
  const totalInquiries = ordersRows.length;
  let acceptedOrders = 0;
  let deliveredOrders = 0;
  let onTimeOrders = 0;
  let lateOrders = 0;

  const productDeliveryMap = {}; // { [productType]: { delivered: 0, late: 0 } }

  // 2. PRODUCTION VARIABLES
  const activeStages = ['DESIGN', 'MILLING', 'JOINERY', 'FINISHING'];
  const queueByStage = { DESIGN: 0, MILLING: 0, JOINERY: 0, FINISHING: 0 };
  const workloadHours = { DESIGN: 0, MILLING: 0, JOINERY: 0, FINISHING: 0 };
  let activeWIP = 0;

  // 3. FINANCIAL PREPARATION (financial_ledger.csv)
  // Sum realised revenue per order ID where type == "REVENUE"
  const orderRevenueMap = {};
  for (const row of ledgerRows) {
    const rowType = (row.type || row.Type || '').trim().toUpperCase();
    if (rowType === 'REVENUE') {
      const desc = row.description || row.Description || '';
      const match = desc.match(/#\s*(\d+)/);
      if (match) {
        const orderId = match[1];
        const rawAmount = String(row.amount || row.Amount || '0').replace(/[^0-9.-]+/g, '');
        const amount = parseFloat(rawAmount) || 0;
        orderRevenueMap[orderId] = (orderRevenueMap[orderId] || 0) + amount;
      }
    }
  }

  // 4. PROCESS orders_data.csv ROWS
  for (const row of ordersRows) {
    const status = (row.status || row.Status || '').trim().toUpperCase();
    const deliveryStatus = (row.deliveryStatus || row.DeliveryStatus || '').trim();
    const acceptanceDate = (row.acceptanceDate || row.AcceptanceDate || '').trim();
    const productType = (row.productType || row.ProductType || 'Unknown').trim();

    // Accepted Orders (acceptanceDate is non-empty)
    const isAccepted = acceptanceDate !== '' && acceptanceDate !== 'null' && acceptanceDate !== 'undefined';
    if (isAccepted) {
      acceptedOrders++;
      workloadHours.DESIGN += parseFloat(row.designHours || row.DesignHours || 0) || 0;
      workloadHours.MILLING += parseFloat(row.millingHours || row.MillingHours || 0) || 0;
      workloadHours.JOINERY += parseFloat(row.joineryHours || row.JoineryHours || 0) || 0;
      workloadHours.FINISHING += parseFloat(row.finishingHours || row.FinishingHours || 0) || 0;
    }

    // Production Active WIP
    if (activeStages.includes(status)) {
      activeWIP++;
      queueByStage[status] = (queueByStage[status] || 0) + 1;
    }

    // Delivery Performance: LOST orders are excluded by virtue of status == 'DELIVERED'
    if (status === 'DELIVERED') {
      deliveredOrders++;

      if (!productDeliveryMap[productType]) {
        productDeliveryMap[productType] = { delivered: 0, late: 0 };
      }
      productDeliveryMap[productType].delivered++;

      if (deliveryStatus.toLowerCase() === 'on time') {
        onTimeOrders++;
      } else if (deliveryStatus.toLowerCase() === 'late') {
        lateOrders++;
        productDeliveryMap[productType].late++;
      }
    }
  }

  // Delivery Rates
  const onTimeRate = deliveredOrders > 0
    ? Number(((onTimeOrders / deliveredOrders) * 100).toFixed(1))
    : 0;

  let highestLateRiskProduct = 'None';
  let highestLateRiskLateOrders = 0;
  let highestLateRiskDeliveredOrders = 0;
  let highestLateRiskRate = 0;

  for (const [prod, stats] of Object.entries(productDeliveryMap)) {
    if (stats.delivered > 0) {
      const rate = Number(((stats.late / stats.delivered) * 100).toFixed(1));
      if (rate > highestLateRiskRate) {
        highestLateRiskRate = rate;
        highestLateRiskProduct = prod;
        highestLateRiskLateOrders = stats.late;
        highestLateRiskDeliveredOrders = stats.delivered;
      }
    }
  }

  // Production Stage Bottleneck (Queue Congestion)
  let topQueueStage = 'DESIGN';
  let topQueueCount = -1;
  for (const stage of activeStages) {
    if (queueByStage[stage] > topQueueCount) {
      topQueueCount = queueByStage[stage];
      topQueueStage = stage;
    }
  }
  const topQueuePercentage = activeWIP > 0
    ? Number(((topQueueCount / activeWIP) * 100).toFixed(1))
    : 0;

  // Production Workload Stage
  const totalWorkload = workloadHours.DESIGN + workloadHours.MILLING + workloadHours.JOINERY + workloadHours.FINISHING;
  let topWorkloadStage = 'DESIGN';
  let topWorkloadHours = -1;
  for (const stage of activeStages) {
    if (workloadHours[stage] > topWorkloadHours) {
      topWorkloadHours = workloadHours[stage];
      topWorkloadStage = stage;
    }
  }
  const topWorkloadPercentage = totalWorkload > 0
    ? Number(((topWorkloadHours / totalWorkload) * 100).toFixed(1))
    : 0;

  // Financial Contribution (Delivered Orders Only)
  const productFinancials = {};
  for (const row of ordersRows) {
    const status = (row.status || row.Status || '').trim().toUpperCase();
    if (status === 'DELIVERED') {
      const id = String(row.id || row.Id || '').trim();
      const productType = (row.productType || row.ProductType || 'Unknown').trim();
      const rawMat = String(row.materialCost || row.MaterialCost || '0').replace(/[^0-9.-]+/g, '');
      const materialCost = parseFloat(rawMat) || 0;
      const orderRevenue = orderRevenueMap[id] || 0;

      if (!productFinancials[productType]) {
        productFinancials[productType] = { realisedRevenue: 0, directMaterialCost: 0 };
      }
      productFinancials[productType].realisedRevenue += orderRevenue;
      productFinancials[productType].directMaterialCost += materialCost;
    }
  }

  let topProduct = 'None';
  let topGrossContribution = -Infinity;
  let topRealisedRevenue = 0;
  let topDirectMaterialCost = 0;

  for (const [prod, stats] of Object.entries(productFinancials)) {
    const grossContribution = stats.realisedRevenue - stats.directMaterialCost;
    if (grossContribution > topGrossContribution) {
      topGrossContribution = grossContribution;
      topProduct = prod;
      topRealisedRevenue = stats.realisedRevenue;
      topDirectMaterialCost = stats.directMaterialCost;
    }
  }

  return {
    DELIVERY: {
      totalInquiries,
      acceptedOrders,
      deliveredOrders,
      onTimeOrders,
      lateOrders,
      onTimeRate,
      highestLateRiskProduct,
      highestLateRiskLateOrders,
      highestLateRiskDeliveredOrders,
      highestLateRiskRate,
      dataSource: 'orders_data.csv',
      limitation: 'Calculations evaluate delivered orders only; lost inquiries and open orders are excluded.'
    },
    PRODUCTION: {
      activeWIP,
      queueByStage,
      workloadHours,
      topQueueStage,
      topQueueCount,
      topQueuePercentage,
      topWorkloadStage,
      topWorkloadHours,
      topWorkloadPercentage,
      dataSource: 'orders_data.csv',
      limitation: 'Queue unit congestion and scheduled workload hours are separate metrics; high queue counts do not necessarily indicate high remaining hours.'
    },
    FINANCIAL: {
      topProduct,
      realisedRevenue: Math.round(topRealisedRevenue),
      directMaterialCost: Math.round(topDirectMaterialCost),
      grossContribution: Math.round(topGrossContribution),
      dataSource: 'orders_data.csv + financial_ledger.csv',
      limitation: 'Gross Contribution After Direct Material Cost is NOT full accounting profit because labour and overhead costs are not allocated to individual orders.'
    },
    VALIDATION: {
      totalInquiries,
      acceptedOrders,
      deliveredOrders,
      onTimeOrders,
      lateOrders,
      onTimeRate,
      activeWIP
    }
  };
}

// ==========================================
// CSV UPLOAD ROUTE
// ==========================================
app.post(
  '/api/upload',
  upload.fields([
    { name: 'ordersFile', maxCount: 1 },
    { name: 'ledgerFile', maxCount: 1 }
  ]),
  (req, res) => {
    try {
      if (!req.files || !req.files.ordersFile || !req.files.ledgerFile) {
        return res.status(400).json({ error: 'Please provide both orders_data.csv and financial_ledger.csv.' });
      }

      const ordersCsv = req.files.ordersFile[0].buffer.toString('utf-8');
      const ledgerCsv = req.files.ledgerFile[0].buffer.toString('utf-8');

      // Robust CSV parsing
      const ordersRecords = parse(ordersCsv, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      const ledgerRecords = parse(ledgerCsv, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      // Compute analytics deterministically
      currentAnalytics = computeDeterministicAnalytics(ordersRecords, ledgerRecords);

      return res.json({
        message: 'Datasets parsed and metrics computed successfully.',
        validation: currentAnalytics.VALIDATION
      });
    } catch (err) {
      console.error('CSV Parsing Error:', err);
      return res.status(500).json({ error: 'Failed to parse CSV files: ' + err.message });
    }
  }
);

// ==========================================
// TWO-STAGE GEMINI ARCHITECTURE
// ==========================================
async function classifyIntent(userQuestion) {
  const prompt = `
You are a business intent classifier for Modern Furniture Co.
Classify the following user query into EXACTLY ONE of these 4 intents:
- delivery_performance
- production_bottleneck
- financial_contribution
- unsupported

Rules:
- Questions on fulfillment, on-time rate, delays, or late products -> delivery_performance
- Questions on queues, stage bottlenecks, workload, WIP, or shopfloor delays -> production_bottleneck
- Questions on top product revenue, margins, contribution, or material costs -> financial_contribution
- Any other question (e.g. employee performance, HR, marketing, general trivia) -> unsupported

Output ONLY valid JSON in this exact structure:
{"intent": "delivery_performance" | "production_bottleneck" | "financial_contribution" | "unsupported"}

Question: "${userQuestion}"
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.0
    }
  });

  try {
    const result = JSON.parse(response.text.trim());
    return result.intent || 'unsupported';
  } catch (err) {
    console.error('Failed to parse intent output:', response.text);
    return 'unsupported';
  }
}

async function generateManagementExplanation(intent, userQuestion) {
  if (intent === 'unsupported') {
    return {
      detectedIntent: 'unsupported',
      directAnswer: 'This prototype currently supports delivery performance, production bottlenecks, and financial contribution analysis.',
      calculationExplanation: 'The query did not map to any of the supported analytical metrics.',
      dataSource: 'orders_data.csv',
      limitation: 'Out-of-scope query.'
    };
  }

  let domainData = {};
  if (intent === 'delivery_performance') domainData = currentAnalytics.DELIVERY;
  if (intent === 'production_bottleneck') domainData = currentAnalytics.PRODUCTION;
  if (intent === 'financial_contribution') domainData = currentAnalytics.FINANCIAL;

  const prompt = `
You are an executive analytics assistant for Modern Furniture Co.
Answer the user's business question using strictly the verified facts provided below.

CRITICAL CONSTRAINTS:
1. NEVER alter, recalculate, or invent any numeric values.
2. Rely ONLY on the provided structured metrics.
3. If discussing financial contribution, you MUST state that Gross Contribution After Direct Material Cost is NOT full accounting profit because labour and overhead are unallocated.

USER QUESTION: "${userQuestion}"
VERIFIED METRICS: ${JSON.stringify(domainData, null, 2)}

Respond with a JSON object matching this schema:
{
  "directAnswer": "A direct, 1-2 sentence executive summary answering the question with the exact provided numbers.",
  "calculationExplanation": "A concise sentence explaining how the metric was derived from the data."
}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  });

  let parsed = { directAnswer: '', calculationExplanation: '' };
  try {
    parsed = JSON.parse(response.text.trim());
  } catch (err) {
    parsed = {
      directAnswer: 'Derived directly from deterministic calculations.',
      calculationExplanation: 'Calculated from structured data records.'
    };
  }

  return {
    detectedIntent: intent,
    directAnswer: parsed.directAnswer,
    calculationExplanation: parsed.calculationExplanation,
    dataSource: domainData.dataSource,
    limitation: domainData.limitation
  };
}

// ==========================================
// QUERY ROUTE
// ==========================================
app.post('/api/ask', async (req, res) => {
  const { question } = req.body;

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Please enter a valid question.' });
  }

  if (!currentAnalytics) {
    return res.status(400).json({
      error: 'No datasets loaded. Please upload orders_data.csv and financial_ledger.csv first.'
    });
  }

  try {
    const detectedIntent = await classifyIntent(question.trim());
    const analysis = await generateManagementExplanation(detectedIntent, question.trim());
    res.json(analysis);
  } catch (error) {
    console.error('Analytics execution error:', error);
    res.status(500).json({
      error: 'An error occurred while evaluating the query.',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});