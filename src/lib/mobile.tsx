import * as React from "react"
import { useIsMobile } from "@/hooks/use-mobile"

/**
 * Central mobile-compatibility layer for PingOS.
 *
 * `useIsMobile()` (existing hook) reports the viewport width.
 * `useMobileCompat()` extends it with touch detection so the UI can
 * swap drag-and-drop interactions for tap-friendly controls and
 * adjust dialog sizing automatically.
 */

export function useTouchDevice(): boolean {
  const [isTouch, setIsTouch] = React.useState(false)

  React.useEffect(() => {
    const mql = window.matchMedia("(pointer: coarse)")
    const onChange = () => setIsTouch(mql.matches)
    mql.addEventListener("change", onChange)
    setIsTouch(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isTouch
}

/**
 * Combined mobile profile used across pages:
 * - isMobile: viewport < 768px (narrow layout)
 * - isTouch:  coarse pointer (no reliable hover/drag)
 */
export function useMobileCompat() {
  const isMobile = useIsMobile()
  const isTouch = useTouchDevice()
  return { isMobile, isTouch, isSmallMobile: isMobile && isTouch }
}
