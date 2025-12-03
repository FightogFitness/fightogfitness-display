import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory "database"
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
 * WEBHOOK fra GoHighLevel
 *
 * Workflow 1 (book/opdater) sender customData:
 *  - appointmentId
 *  - clientName
 *  - coachName
 *  - isCancelled = false
 *
 * Workflow 2 (cancel) sender:
 *  - appointmentId
 *  - isCancelled = true
 *
 * startTime og endTime tager vi fra body.calendar.startTime / endTime
 */
app.post("/ghl-webhook", (req, res) => {
  const body = req.body;
  console.log("FULL PAYLOAD FROM GHL:", JSON.stringify(body, null, 2));

  try {
    const custom = body.customData || {};
    const calendar = body.calendar || {};
    const user = body.user || {};

    // Flag fra customData
    const isCancelledFlag = String(custom.isCancelled || "").toLowerCase().trim();
    const isCancelled =
      isCancelledFlag === "true" ||
      isCancelledFlag === "1" ||
      isCancelledFlag === "yes";

    // ID
    const appointmentId =
      custom.appointmentId ||
      calendar.appointmentId ||
      body.contact_id ||
      body.contactId;

    if (!appointmentId) {
      console.log("Mangler appointmentId, gemmer ikke aftale.");
      return res.json({ success: false, message: "Ingen appointmentId" });
    }

    // Tider: tag altid fra calendar først
    let startTime = calendar.startTime || custom.startTime;
    let endTime = calendar.endTime || custom.endTime;

    // Fallback hvis GHL en dag ændrer felter
    if (!startTime && body.startTime) startTime = body.startTime;
    if (!endTime && body.endTime) endTime = body.endTime;

    const clientName =
      custom.clientName ||
      body.full_name ||
      body.email ||
      body.contact_id ||
      "Ukendt klient";

    const coachName =
      custom.coachName ||
      user.firstName ||
      "Coach";

    // Find eksisterende aftale
    const index = appointments.findIndex((a) => a.id === appointmentId);

    // CANCEL-FLOW: markér som cancelled (rød)
    if (isCancelled) {
      if (index >= 0) {
        appointments[index].status = "cancelled";
        console.log("Aftale markeret som CANCELLED:", appointmentId);
      } else {
        const dummyStart = startTime || new Date().toISOString();
        const dummyEnd =
          endTime ||
          new Date(new Date(dummyStart).getTime() + 30 * 60000).toISOString();

        const dummyAppt = {
          id: appointmentId,
          clientName,
          coachName,
          startTime: dummyStart,
          endTime: dummyEnd,
          durationMinutes: getDurationMinutes(dummyStart, dummyEnd),
          status: "cancelled"
        };
        appointments.push(dummyAppt);
        console.log("Aflyst aftale oprettet som CANCELLED (dummy tider):", appointmentId);
      }

      return res.json({ success: true, cancelled: true });
    }

    // BOOK/OPDATER-FLOW (grøn)
    // Hvis tider mangler, brug "nu" + 30 min som fallback, så vi IKKE breaker
    if (!startTime) {
      startTime = new Date().toISOString();
      console.log("Mangler startTime, bruger nu som fallback for:", appointmentId);
    }
    if (!endTime) {
      endTime = new Date(new Date(startTime).getTime() + 30 * 60000).toISOString();
      console.log("Mangler endTime, bruger start + 30 min som fallback for:", appointmentId);
    }

    const durationMinutes = getDurationMinutes(startTime, endTime);

    const newAppt = {
      id: appointmentId,
      clientName,
      coachName,
      startTime,
      endTime,
      durationMinutes,
      status: "active"
    };

    if (index >= 0) {
      appointments[index] = newAppt;
      console.log("Aftale opdateret:", appointmentId);
    } else {
      appointments.push(newAppt);
      console.log("Aftale tilføjet:", appointmentId);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Fejl i webhook-handler:", err);
    return res.status(500).json({ success: false, error: "Serverfejl i webhook" });
  }
});

/**
 * API – kun kommende aftaler (endTime >= nu)
 */
app.get("/api/appointments", (req, res) => {
  const now = new Date();

  const upcoming = appointments
    .filter((a) => {
      const end = new Date(a.endTime);
      return !isNaN(end.getTime()) && end >= now;
    })
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  console.log("Sender upcoming appointments:", upcoming);
  res.json(upcoming);
});

/**
 * DISPLAY-side
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

        if (!data || data.length === 0) {
          content.innerHTML = '<div style="margin-top:20px;color:#aaa;font-size:22px;">Ingen kommende personlige træninger.</div>';
          return;
        }

        let rows = "";
        data.forEach((a) => {
          const s = new Date(a.startTime);
          const e = new Date(a.endTime);
          const cancelled = a.status === "cancelled";

          const bgColor = cancelled ? "#7f1d1d" : "#064e3b"; // rød / grøn
          const statusLabel = cancelled ? "Aflyst" : (a.durationMinutes || "") + " min";

          rows += \`
            <tr style="background-color: \${bgColor};">
              <td>\${s.toLocaleDateString("da-DK")}</td>
              <td>\${s.toLocaleTimeString("da-DK")} - \${e.toLocaleTimeString("da-DK")}</td>
              <td>\${a.clientName} \${cancelled ? "(Aflyst)" : ""}</td>
              <td>\${a.coachName}</td>
              <td>\${statusLabel}</td>
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
                <th>Status / Varighed</th>
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
