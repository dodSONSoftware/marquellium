-- Acceptance only: requires explicit authorization and macOS Accessibility.
-- Keep opening and choosing in one call: returning to the caller can dismiss
-- the Dock context menu. Never substitute Force Quit or an application event.
with timeout of 30 seconds
    tell application "System Events"
        tell process "Dock"
            tell UI element "Marquellium" of list 1
                perform action "AXShowMenu"
                if not (exists menu item "Quit" of menu 1) then error "Marquellium Dock Quit item unavailable"
                click menu item "Quit" of menu 1
            end tell
        end tell
    end tell
end timeout
