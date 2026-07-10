import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

/** Format an ISO timestamp as a Chinese relative time string, e.g. "3天前". */
export function formatRelativeTime(iso: string): string {
  return dayjs(iso).fromNow();
}
