import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json()); // så vi kan læse JSON fra GHL

// Simpel "database" i hukommelsen (nulstilles hvis server genstartes)
let appointments = [];

/**
 * Beregn varighed i minutter mellem start og slut
 */
function getDurationMinutes(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  return Math.round((end - start) / (1000 * 60));
}

/**
 * Webhook endpoint til GoHighLevel
 * URL i GHL bliver: https://DIT-RENDER-DOMÆNE/ghl-webhook
 */
app.post("/ghl-webhook", (req, res) => {
  const body = req.body;

  // Log hele payloaden, så vi kan se præcis hvad GHL sender
  console.log("Webhook payload fra GHL:", JSON.stringify(body, null, 2));

  try {
    // ID på aftalen
    const appointmentId = body.id || body.appointmentId || body.appointment_id;

    // Status (booked, cancelled, osv.)
    const status = (body.status || body.appointmentStatus || "booked").toLowerCase();

    // Start og slut – forskellige navne afhængigt af GHL
    const startTime =
      body.appointment_start_time ||
      body.startTime ||
      body.start_time ||
      body.appointmentStartTime;

    const endTime =
      body.appointment_end_time ||
      body.endTime ||
      body.end_time ||
      body.appointmentEndTime;

    // Klientnavn
    const clientName =
      (body.contact && (body.contact.name || body.contact.full_name)) ||
      body.clientName ||
      body.full_name ||
      "Ukendt klient";

    // Træner / assigned user
    const coachName =
      body.assigned_user_name ||
      (body.user && body.user.name) ||
      body.assignedUserName ||
      body.trainerName ||
      "Coach";

    if (!appointmentId || !startTime || !endTime) {
      console.warn("Mangler vigtige felter i webhooken.");
      return res.status(400).json({
        success: false,
        message:
          "Webhook modtaget, men der mangler appointmentId/startTime/endTime. Tjek felt-navne i server.js."
      });
    }

    // Hvis aftalen er aflyst / no-show → fjern den fra listen
    if (["cancelled", "canceled", "no_show"].includes(status)) {
      appointments = appointments.filter((a) => a.id !== appointmentId);
      console.log("Aftale aflyst/fjernet:", appointmentId);
    } else {
      const durationMinutes = getDurationMinutes(startTime, endTime);

      const newAppt = {
        id: appointmentId,
        clientName,
        coachName,
        startTime,
        endTime,
        durationMinutes
      };

      // Hvis aftalen findes, opdater den – ellers tilføj
      const existingIndex = appointments.findIndex((a) => a.id === appointmentId);
      if (existingIndex >= 0) {
        appointments[existingIndex] = newAppt;
        console.log("Opdaterede aftale:", appointmentId);
      } else {
        appointments.push(newAppt);
        console.log("Tilføjede ny aftale:", appointmentId);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Fejl i webhook:", err);
    return res.status(500).json({ success: false, error: "Serverfejl i webhook" });
  }
});

/**
 * JSON API til kommende aftaler
 * Kan bruges til debugging: /api/appointments
 */
app.get("/api/appointments", (req, res) => {
  const now = new Date();

  const upcoming = appointments
    .filter((a) => new Date(a.startTime) >= now)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .slice(0, 20); // max 20 ad gangen

  res.json(upcoming);
});

/**
 * TV-display side
 * Dette er URL'en du bruger på dit TV: /display
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
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #050816;
        color: #f9fafb;
      }
      .wrapper {
        padding: 32px;
      }
      h1 {
        font-size: 42px;
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 2px;
      }
      .subtitle {
        font-size: 18px;
        color: #9ca3af;
        margin-bottom: 24px;
      }
      .time {
        font-size: 18px;
        color: #e5e7eb;
        margin-bottom: 24px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
      }
      th, td {
        padding: 14px 12px;
        text-align: left;
      }
      th {
        font-size: 16px;
        text-transform: uppercase;
        letter-spacing: 1px;
        border-bottom: 2px solid #374151;
      }
      tr:nth-child(even) {
        background: rgba(15, 23, 42, 0.80);
      }
      tr:nth-child(odd) {
        background: rgba(15, 23, 42, 0.55);
      }
      td {
        font-size: 18px;
      }
      .client {
        font-weight: 600;
        font-size: 20px;
      }
      .coach {
        color: #a5b4fc;
        font-weight: 500;
      }
      .no-data {
        font-size: 22px;
        margin-top: 32px;
        color: #9ca3af;
      }
      .badge {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid #4b5563;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #d1d5db;
        margin-bottom: 12px;
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="badge">FightogFitness</div>
      <h1>Kommende Personlige Træninger</h1>
      <div class="subtitle">Næste bookinger i kalenderen (trigger: "personlig træning" i GHL)</div>
      <div class="time">Senest opdateret: <span id="now"></span></div>

      <div id="content"></div>
    </div>

    <script>
      async function loadAppointments() {
        try {
          const res = await fetch("/api/appointments");
          const data = await res.json();

          const nowEl = document.getElementById("now");
          nowEl.textContent = new Date().toLocaleString("da-DK", {
            hour: "2-digit",
            minute: "2-digit",
            day: "2-digit",
            month: "2-digit",
            year: "numeric"
          });

          const content = document.getElementById("content");

          if (!data || data.length === 0) {
            content.innerHTML = '<div class="no-data">Ingen kommende personlige træninger i kalenderen.</div>';
            return;
          }

          let rows = "";
          data.forEach((a) => {
            const start = new Date(a.startTime);
            const end = new Date(a.endTime);

            const startStr = start.toLocaleTimeString("da-DK", {
              hour: "2-digit",
              minute: "2-digit"
            });

            const endStr = end.toLocaleTimeString("da-DK", {
              hour: "2-digit",
              minute: "2-digit"
            });

            const dayStr = start.toLocaleDateString("da-DK", {
              weekday: "short",
              day: "2-digit",
              month: "2-digit"
            });

            rows += \`
              <tr>
                <td>\${dayStr}</td>
                <td>\${startStr} - \${endStr}</td>
                <td class="client">\${a.clientName}</td>
                <td class="coach">\${a.coachName}</td>
                <td>\${a.durationMinutes || ""} min</td>
              </tr>
            \`;
          });

          content.innerHTML = \`
            <table>
              <thead>
                <tr>
                  <th>Dag</th>
                  <th>Tid</th>
                  <th>Klient</th>
                  <th>Træner</th>
                  <th>Varighed</th>
                </tr>
              </thead>
              <tbody>\${rows}</tbody>
            </table>
          \`;
        } catch (err) {
          console.error("Fejl ved hentning af aftaler", err);
          document.getElementById("content").innerHTML =
            '<div class="no-data">Kan ikke hente data lige nu.</div>';
        }
      }

      loadAppointments();
      setInterval(loadAppointments, 20000);
    </script>
  </body>
  </html>
  `;

  res.send(html);
});

// Start serveren
app.listen(PORT, () => {
  console.log("Server kører på port " + PORT);
});
