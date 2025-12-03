import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory database
let appointments = [];

/**
 * Beregn varighed i minutter
 */
function getDurationMinutes(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return undefined;
  return Math.round((end - start) / (1000 * 60));
}

/**
 * WEBHOOK: GHL sender data hertil
 * Vi bruger KUN customData nu.
 */
app.post("/ghl-webhook", (req, res) => {
  console.log("FULL PAYLOAD FROM GHL:", JSON.stringify(req.body, null, 2));

  const body = req.body;
  const custom = body.customData || {};

  const appointmentId = custom.appointmentId;
  const startTime = custom.startTime;
  const endTime = custom.endTime;
  const clientName = custom.clientName || "Ukendt klient";
  const coachName = custom.coachName || "Coach";

  if (!appointmentId || !startTime || !endTime) {
    console.log("CUSTOMDATA MODTAGET:", custom); // debug
    return res.status(400).json({
      success: false,
      message:
        "Webhook modtaget, men der mangler appointmentId/startTime/endTime."
    });
  }

  const durationMinutes = getDurationMinutes(startTime, endTime);

  const newAppt = {
    id: appointmentId,
    clientName,
    coachName,
    startTime,
    endTime,
    durationMinutes
  };

  const index = appointments.findIndex((a) => a.id === appointmentId);

  if (index >= 0) {
    appointments[index] = newAppt;
    console.log("Aftale opdateret:", appointmentId);
  } else {
    appointments.push(newAppt);
    console.log("Aftale tilføjet:", appointmentId);
  }

  return res.json({ success: true });
});

/**
 * API endpoint der viser ALLE appointments (for debugging)
 * Ikke kun kommende.
 */
app.get("/api/appointments", (req, res) => {
  console.log("Sender appointments:", appointments);
  res.json(appointments);
});

/**
 * DISPLAY-siden
 */
app.get("/display", (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html lang="da">
  <head>
    <meta charset="UTF-8" />
    <title>FightogFitness - Personlige Træninger</title>
    <meta http-equiv="refresh" content="30" />
    <style>
      body {
        margin: 0;
        font-family: system-ui, sans-serif;
        background: #050816;
        color: #f9fafb;
      }
      .wrapper { padding: 32px; }
      .badge {
        display: inline-block;
        padding: 6px 12px;
        border: 1px solid #4b5563;
        border-radius: 999px;
        margin-bottom: 12px;
        color: #d1d5db;
      }
      h1 {
        font-size: 40px;
        margin: 0 0 5px;
      }
      .subtitle { color: #9ca3af; margin-bottom: 20px; }
      .time { color: #ccc; margin-bottom: 20px; }

      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 12px; text-align: left; font-size: 18px; }
      th { border-bottom: 2px solid #374151; text-transform: uppercase; }

      tr:nth-child(even) { background: rgba(255,255,255,0.03); }
      tr:nth-child(odd)  { background: rgba(255,255,255,0.06); }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="badge">FightogFitness</div>
      <h1>Kommende Personlige Træninger</h1>
      <div class="subtitle">Live fra GHL kalender: "Personlig Træning"</div>
      <div class="time">Senest opdateret: <span id="now"></span></div>
      <div id="content"></div>
    </div>

    <script>
      async function loadAppointments() {
        const res = await fetch("/api/appointments");
        const data = await res.json();

        document.getElementById("now").textContent = new Date().toLocaleString("da-DK");

        const content = document.getElementById("content");

        if (data.length === 0) {
          content.innerHTML = '<div style="margin-top:20px;color:#aaa;font-size:22px;">Ingen kommende personlige træninger.</div>';
          return;
        }

        let rows = "";
        data.forEach((a) => {
          const s = new Date(a.startTime);
          const e = new Date(a.endTime);

          rows += \`
            <tr>
              <td>\${s.toLocaleDateString("da-DK")}</td>
              <td>\${s.toLocaleTimeString("da-DK")} - \${e.toLocaleTimeString("da-DK")}</td>
              <td>\${a.clientName}</td>
              <td>\${a.coachName}</td>
              <td>\${a.durationMinutes || ""} min</td>
            </tr>
          \`;
        });

        content.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>Dato</th>
                <th>Tid</th>
                <th>Klient</th>
                <th>Træner</th>
                <th>Varighed</th>
              </tr>
            </thead>
            <tbody>\${rows}</tbody>
          </table>
        \`;
      }

      loadAppointments();
      setInterval(loadAppointments, 20000);
    </script>
  </body>
  </html>
  `;

  res.send(html);
});

app.listen(PORT, () => {
  console.log("Server kører på port " + PORT);
});

