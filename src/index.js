const request = require("request-promise");
const dateFns = require("date-fns");
const dateFnsTZ = require("date-fns-tz");
const { last } = require("lodash");

const RowMode = {
  STATUS: "S",
  PASSING: "M"
};

const Column = {
  ROW_MODE: "B",
  CHIP: "N",
  DEVICE_ID: "Y",
  CODE: "C",
  BATTERY_LEVEL: "A",
  TIMESTAMP: "E"
};

const TIME_LIMIT_SEC = 30;
const NEW_LINE = "\n";
const NEW_COLUMN = "\t";
const DATETIME_FORMAT = "yyyy-MM-dd HH:mm:ss";
const EMIT_SERVER_TIMEZONE = "Europe/Oslo";
const NAVISPORT_DEVICE_URL = "https://navisport.fi/api/devices";
const REQUEST_HEADERS = {
  "Content-type": "application/json"
};

let registeredPassings = [];
let registeredStatusMessages = [];

let devices = [];

// First update devices
updateDevices();

// Update devices every 5min
setInterval(() => {
  updateDevices();
}, 300000);

/* - Update passings and status messages every second
 * - Get all messages which are under 30sec old
 * - Change status messages to better format and then store messages to prevent duplicate messages
 * - Clear all stored messages which are over 30sec old
 */
setInterval(async () => {
  await request
    .get({
      url:
        "http://emittiming.cloudapp.net/emitphp/get_stream.php?time=" +
        dateFns.format(
          dateFnsTZ.utcToZonedTime(
            dateFns.subSeconds(new Date(), TIME_LIMIT_SEC),
            EMIT_SERVER_TIMEZONE
          ),
          DATETIME_FORMAT
        )
    })
    .then(
      (response) => {
        const rows = response.split(NEW_LINE).filter((r) => r.length);

        let passings = [];
        let statusMessages = [];

        rows.forEach((row) => {
          const columns = row.split(NEW_COLUMN);

          const mode = getColumn(columns, Column.ROW_MODE);
          const deviceId = getColumn(columns, Column.DEVICE_ID);
          const updated = new Date();

          if (mode === RowMode.PASSING) {
            passings.push({
              deviceId,
              chip: getColumn(columns, Column.CHIP),
              code: getColumn(columns, Column.CODE),
              timestamp: dateFnsTZ.zonedTimeToUtc(
                new Date(
                  `${new Date().toISOString().split("T")[0]} ${getColumn(
                    columns,
                    Column.TIMESTAMP
                  )}`
                ),
                "Europe/Helsinki"
              ),
              updated
            });
          } else if (mode === RowMode.STATUS) {
            const code = getColumn(columns, Column.CODE);
            const batteryLevel = last(
              getColumn(columns, Column.BATTERY_LEVEL)?.split("-") || []
            ) || 0;
            statusMessages.push({
              deviceId,
              code,
              batteryLevel,
              updated
            });
          }
        });

        // Filter out passings and status messages which are handled before
        passings = passings.filter(
          (p) => !registeredPassings.find((rp) => rp.chip === p.chip && rp.deviceId === p.deviceId)
        );
        statusMessages = statusMessages.filter(
          (m) =>
            !registeredStatusMessages.find((rm) => rm.deviceId === m.deviceId)
        );

        if (passings.length) {
          passings.forEach((p) =>
            registeredPassings.push(p)
          );
          sendPassings(passings);
        }

        if (statusMessages.length) {
          statusMessages.forEach((s) =>
            registeredStatusMessages.push(s)
          );
          sendStatusMessages(statusMessages);
        }

        // Filter out old passings and status messages
        registeredPassings = registeredPassings.filter(
          (rp) => dateFns.addSeconds(rp.updated, TIME_LIMIT_SEC) > new Date() // Difference 30sec
        );
        registeredStatusMessages = registeredStatusMessages.filter(
          (rm) =>
            dateFns.addSeconds(rm.updated, TIME_LIMIT_SEC / 2) > new Date() // Difference 15sec
        );
      },
      (error) => {
        console.log(error);
      }
    );
}, 1000);

function getColumn(columns, prefix) {
  const column = columns.find((c) => c.charAt(0) === prefix);
  return column ? column.substring(1) : null;
}

function sendStatusMessages(statusMessages) {
  statusMessages
    .filter((s) => devices.includes(s.deviceId))
    .map(async (statusMessage) => {
        await request.get({
          url: `${NAVISPORT_DEVICE_URL}/${statusMessage.deviceId}/ping`,
          headers: REQUEST_HEADERS
          //   json: true,
          //   body: statusMessage
        });
        console.log("Device status", statusMessages);
      }
    );
}

function sendPassings(passings) {
  const body = passings.filter((p) => devices.includes(p.deviceId));
  if (body.length) {
    request
      .post({
        url: `${NAVISPORT_DEVICE_URL}/data`,
        headers: REQUEST_HEADERS,
        json: true,
        body
      })
      .then((response) => {
        console.log("response", response);
      });
  }
}

function updateDevices() {
  request
    .get({
      url: `${NAVISPORT_DEVICE_URL}`,
      headers: REQUEST_HEADERS,
      json: true
    })
    .then((response) => {
      devices = response
        .filter(
          ({ deviceType, organisationId }) =>
            deviceType === "RASPBERRY" && organisationId !== null
        )
        .map(({ id }) => id);
    });
}
