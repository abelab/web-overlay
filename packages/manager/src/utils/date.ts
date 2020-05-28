/**
 * Format date in HH:MM:SS.mmm format
 * @param date Date object
 */
export function formatDate(date?: Date): string {
    date = date || new Date();
    const hour = date.getHours().toString().padStart(2, "0");
    const minute = date.getMinutes().toString().padStart(2, "0");
    const second = date.getSeconds().toString().padStart(2, "0");
    const msec = date.getMilliseconds().toString().padStart(3, "0");
    return `${hour}:${minute}:${second}.${msec}`;
}
