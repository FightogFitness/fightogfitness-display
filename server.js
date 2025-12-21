import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// In-memory "database" for aftaler
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
 * Ryd gamle aftaler (alt hvor slut-tid er før nu)
 */
function cleanupOldAppointments() {
  const now = new Date();
  appointments = appointments.filter((a) => {
    const end = new Date(a.endTime);
    return !isNaN(end.getTime()) && end >= now;
  });
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
    cleanupOldAppointments();

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

    // Fallback hvis GHL ændrer felter
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

    // BOOK/OPDATER-FLOW (aktiv)
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
  cleanupOldAppointments();

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
 * DISPLAY-side (PT-tavle)
 * - Blå rækker = aktive
 * - Røde rækker = aflyste
 * - Øverst: "Næste i ringen" kort for data[0]
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
        background: #020617;
        color: #f9fafb;
      }
      .wrapper { padding: 32px; }
      .badge {
        display: inline-block;
        padding: 6px 12px;
        border: 1px solid #1d4ed8;
        border-radius: 999px;
        margin-bottom: 12px;
        color: #bfdbfe;
        font-size: 14px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        font-size: 42px;
        margin: 0 0 5px;
      }
      .subtitle { color: #9ca3af; margin-bottom: 16px; }
      .time { color: #e5e7eb; margin-bottom: 24px; }

      .next-card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 16px 20px;
        border-radius: 16px;
        margin-bottom: 24px;
        background: linear-gradient(135deg, #1d4ed8, #0f172a);
        box-shadow: 0 18px 40px rgba(15,23,42,0.6);
      }
      .next-title {
        font-size: 18px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: #bfdbfe;
      }
      .next-name {
        font-size: 28px;
        font-weight: 600;
      }
      .next-meta {
        font-size: 18px;
        color: #e5e7eb;
      }
      .next-cancelled {
        background: linear-gradient(135deg, #b91c1c, #450a0a);
      }

      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td { padding: 12px; text-align: left; font-size: 16px; }
      th {
        border-bottom: 2px solid #1f2937;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #e5e7eb;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="badge">FightogFitness</div>
      <h1>Kommende Personlige Træninger</h1>
      <div class="subtitle">Live fra GHL kalender: "Personlig Træning"</div>
      <div class="time">Senest opdateret: <span id="now"></span></div>
      <div id="next"></div>
      <div id="content"></div>
    </div>

    <script>
      async function loadAppointments() {
        const res = await fetch("/api/appointments");
        const data = await res.json();

        document.getElementById("now").textContent = new Date().toLocaleString("da-DK");

        const content = document.getElementById("content");
        const nextEl = document.getElementById("next");

        if (!data || data.length === 0) {
          nextEl.innerHTML = "";
          content.innerHTML = '<div style="margin-top:20px;color:#aaa;font-size:22px;">Ingen kommende personlige træninger.</div>';
          return;
        }

        const next = data[0];
        const rest = data.slice(1);

        function fmtDate(d) {
          return d.toLocaleDateString("da-DK");
        }
        function fmtTime(d) {
          return d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
        }

        const nextStart = new Date(next.startTime);
        const nextEnd = new Date(next.endTime);
        const nextCancelled = next.status === "cancelled";

        const nextDate = fmtDate(nextStart);
        const nextTime = fmtTime(nextStart) + " - " + fmtTime(nextEnd);

        nextEl.innerHTML = \`
          <div class="next-card \${nextCancelled ? "next-cancelled" : ""}">
            <div class="next-title">Næste i ringen</div>
            <div class="next-name">\${next.clientName} \${nextCancelled ? "(Aflyst)" : ""}</div>
            <div class="next-meta">\${nextDate} · \${nextTime} · Træner: \${next.coachName}</div>
          </div>
        \`;

        if (rest.length === 0) {
          content.innerHTML = "";
          return;
        }

        let rows = "";
        rest.forEach((a) => {
          const s = new Date(a.startTime);
          const e = new Date(a.endTime);
          const cancelled = a.status === "cancelled";

          const bgColor = cancelled ? "#7f1d1d" : "#1d4ed8";
          const statusLabel = cancelled ? "Aflyst" : (a.durationMinutes || "") + " min";

          rows += \`
            <tr style="background-color: \${bgColor};">
              <td>\${fmtDate(s)}</td>
              <td>\${fmtTime(s)} - \${fmtTime(e)}</td>
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

/**
 * ADS-side – YouTube-video i fuld skærm
 */
app.get("/ads", (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html lang="da">
  <head>
    <meta charset="UTF-8" />
    <title>FightogFitness Ads Video</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #000;
      }
      iframe {
        border: none;
        width: 100%;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <iframe
      src="https://www.youtube.com/watch?v=XzsPWBlKDBU"
      allow="autoplay; fullscreen"
      allowfullscreen
    ></iframe>
  </body>
  </html>
  `;

  res.send(html);
});

/**
 * TV-side – automatisk skift mellem /display og /ads
 *
 *  - 06:00–22:00:
 *      - Minut 0-6  → /ads (reklamer)
 *      - Minut 7-59 → /display (PT-tavle)
 *  - Udenfor 06-22 → altid /display
 */
app.get("/tv", (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html lang="da">
  <head>
    <meta charset="UTF-8" />
    <title>FightogFitness TV</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: #000;
      }
      iframe {
        border: none;
        width: 100%;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <iframe id="frame" src="/display"></iframe>

    <script>
      function updateMode() {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();

        const withinOpening = hour >= 6 && hour < 22;
        const showAds = withinOpening && minute < 7;

        const frame = document.getElementById("frame");
        const current = frame.getAttribute("src");

        if (showAds && current !== "/ads") {
          frame.setAttribute("src", "/ads");
        } else if (!showAds && current !== "/display") {
          frame.setAttribute("src", "/display");
        }
      }

      updateMode();
      setInterval(updateMode, 15000);
    </script>
  </body>
  </html>
  `;

  res.send(html);
});

app.listen(PORT, () => {
  console.log("Server kører på port " + PORT);
});

