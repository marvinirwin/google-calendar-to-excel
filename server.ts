import {google, calendar_v3} from 'googleapis';
import {GoogleSpreadsheet} from 'google-spreadsheet';
import {config} from 'dotenv';
import {format, isWithinInterval, parse} from 'date-fns';
import * as events from "events";
// 11/24/2022 20:35:00
const parseSpreadsheetDate = (dateStr: string) => parse(dateStr, "MM/dd/yyyy H:mm:ss", new Date());

config()

const jsonCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS as string);
const fromJsonCredentials = google.auth.fromJSON(jsonCredentials);
// @ts-ignore
fromJsonCredentials.scopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events"
];
const calendarId = process.env.CALENDAR_ID as string;
const sheetId = process.env.SHEET_ID as string;

const secondsInADay = 86400;

const timeOffsetStart = parseInt(process.env.TIME_OFFSET_START || String(secondsInADay * 31));
const timeOffsetEnd = parseInt(process.env.TIME_OFFSET_END || String(secondsInADay * 31));

type SpreadsheetRowType = {
    Start: string,
    Student: string
};

const isWithinDateRange = (date: Date) => {
    return isWithinInterval(date, {
        start: new Date(((new Date().getTime() / 1000) - timeOffsetStart) * 1000),
        end: new Date(((new Date().getTime() / 1000) + timeOffsetEnd) * 1000)
    })
}

class SpreadsheetRowHelper {
    constructor(public r: SpreadsheetRowType) {
    }

    isWithinDateRange() {
        return isWithinDateRange(this.Start())
    }

    Student(): string {
        return this.r.Student;
    }

    Start(): Date {
        return parseSpreadsheetDate(this.r.Start);
    }
}


const removeTimezoneFromGoogleDate = (dateString: string) => {
    return dateString.replace(/[+-]\d{2}:\d{2}$/, '');
}

const isSame = (spreadsheetRecord: SpreadsheetRowHelper, event: calendar_v3.Schema$Event) => {
    const student = spreadsheetRecord.Student();
    const summary = event.summary;
    const toISOString = spreadsheetRecord.Start().toISOString();
    const date = new Date(removeTimezoneFromGoogleDate(event.start?.dateTime as string));
    const start = date.toISOString();
    if (student === 'Mason 1on1') {
        console.log(date)
    }
    return student === summary &&
        toISOString === start;
};

(async () => {
    const runIteration = async () => {
        const calendar = google.calendar({version: 'v3', auth: fromJsonCredentials});
        const doc = new GoogleSpreadsheet(sheetId);
        await doc.useServiceAccountAuth(jsonCredentials);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        // Only take the records and events from within a month, so we don't have too many things
        const fetchAllCalendarEvents = async () => {
            const response = await calendar.events.list({
                    calendarId,
                    timeMin: new Date((new Date().getTime() - (timeOffsetStart * 1000))).toISOString(),
                    timeMax: new Date((new Date().getTime() + (timeOffsetEnd * 1000))).toISOString(),
                    singleEvents: true,
                    orderBy: 'startTime',
                },
                {}
            )

            return response.data.items || [];
        }
        const fetchAllSpreadsheetRecords = async () => {
            const rows: SpreadsheetRowHelper[] = (await sheet.getRows()).map(row => new SpreadsheetRowHelper(row as unknown as SpreadsheetRowType));
            return rows.filter(row => row.isWithinDateRange());
        }

        const compareEventsAndSpreadsheet = async () => {
            const allEvents = await fetchAllCalendarEvents();
            const allSpreadsheetRecords = await fetchAllSpreadsheetRecords();
            const eventsWhichDontExistInTheSpreadsheet = allEvents
                .filter(
                    event => {
                        return !allSpreadsheetRecords
                            .find(
                                spreadsheetRecord => {
                                    return isSame(spreadsheetRecord, event);
                                }
                            );
                    }
                );

            const spreadsheetRecordsWhichDontExistInTheCalendar = allSpreadsheetRecords
                // First filter the records which are actually student attendance records
                .filter(spreadsheetRecord => spreadsheetRecord.Student())
                // Now filter records which dont exist as events
                .filter(spreadsheetRecord => {
                    const existsInCalendar = allEvents.find(event => {
                        return isSame(spreadsheetRecord, event)
                    })
                    return !existsInCalendar;
                });
            // Now delete these
            for (let i = 0; i < spreadsheetRecordsWhichDontExistInTheCalendar.length; i++) {
                const spreadsheetRecordsWhichDontExistInTheCalendarElement = spreadsheetRecordsWhichDontExistInTheCalendar[i];
                console.log(`delete ${spreadsheetRecordsWhichDontExistInTheCalendarElement.Student()} ${spreadsheetRecordsWhichDontExistInTheCalendarElement.Start()}`)
            }

            const insertRecordsIntoSpreadsheet = async () => {
                const fmtDate = (d: undefined | null | string) => {
                    let removeTimezoneFromGoogleDate1 = d && removeTimezoneFromGoogleDate(d);
                    let date = removeTimezoneFromGoogleDate1 &&  new Date(removeTimezoneFromGoogleDate1);
                    return date ?
                        format(date, "M/d/yyyy H:mm:ss") :
                        date
                }
                const result = await sheet.addRows(
                    eventsWhichDontExistInTheSpreadsheet.map(evElement => {
                            return (
                                {
                                    Student: evElement.summary as string,
                                    Start: fmtDate(evElement.start?.dateTime) || "No start date",
                                    End: fmtDate(evElement.end?.dateTime) || "No end date",
                                }
                            );
                        }
                    )
                );
            }
            await insertRecordsIntoSpreadsheet()
            // Insert those events into the spreadsheet
            // Expand all filter views to encapsulate the whole spreadsheet
            // Expand all formulas to encapsulate the whole spreadsheet
        }
        await compareEventsAndSpreadsheet();
    }
    try {
        await runIteration();
    } catch (e) {
        console.error(e)
    }
})();

