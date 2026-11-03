//! AppKit's Dock/Apple-event termination does not emit Tauri ExitRequested in
//! the pinned Tao runtime. Veto it synchronously, then use our asynchronous
//! document coordinator, which exits through AppHandle::exit only on success.
use objc2::{
    runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::{ffi::CStr, sync::OnceLock};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

extern "C-unwind" fn should_terminate(
    _: &AnyObject,
    _: Sel,
    _: Option<&AnyObject>,
) -> NSApplicationTerminateReply {
    eprintln!("close-flow quit source=appkit-applicationShouldTerminate");
    if let Some(app) = APP.get() {
        crate::quit_app(app.clone());
    }
    // Return to the ordinary run loop so webviews can resolve Save/Discard/
    // Cancel. NSTerminateLater would run AppKit's modal loop instead.
    NSApplicationTerminateReply::TerminateCancel
}

fn termination_subclass(name: &CStr, superclass: &AnyClass) -> Result<&'static AnyClass, String> {
    let mut builder = ClassBuilder::new(name, superclass)
        .ok_or("could not register the Marquellium termination delegate")?;
    // SAFETY: this is AppKit's exact selector/ABI and typed NSUInteger reply.
    // No instance variables are added; every other delegate method is inherited.
    unsafe {
        builder.add_method(
            sel!(applicationShouldTerminate:),
            should_terminate as extern "C-unwind" fn(_, _, _) -> _,
        );
    }
    let subclass = builder.register();
    if subclass.instance_size() != superclass.instance_size() {
        return Err("termination delegate instance layout changed".into());
    }
    Ok(subclass)
}

pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let main = MainThreadMarker::new().ok_or("termination hook must install on the main thread")?;
    let application = NSApplication::sharedApplication(main);
    let delegate = application
        .delegate()
        .ok_or("application delegate is unavailable")?;
    let object: &AnyObject = (*delegate).as_ref();
    let original = object.class();
    let subclass = termination_subclass(c"MarquelliumTerminationDelegate", original)?;
    APP.set(app.clone())
        .map_err(|_| "termination hook already installed")?;
    // SAFETY: setup owns this app delegate on the main thread before requests
    // can arrive. The subclass adds no ivars, has identical size, inherits all
    // runtime callbacks/deallocation, and overrides only the exact AppKit ABI.
    let previous = unsafe { AnyObject::set_class(object, subclass) };
    assert!(
        std::ptr::eq(previous, original),
        "application delegate changed during setup"
    );
    // Refresh AppKit's optional-delegate-method cache. The retained local keeps
    // the original delegate alive while its weak application property resets.
    application.setDelegate(None);
    application.setDelegate(Some(&delegate));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::{class, msg_send, rc::Retained};

    extern "C-unwind" fn probe(_: &AnyObject, _: Sel) -> usize {
        42
    }

    #[test]
    fn termination_override_preserves_delegate_layout_and_inherited_callbacks() {
        let mut base = ClassBuilder::new(c"MarquelliumTestDelegate", class!(NSObject)).unwrap();
        // SAFETY: test-only method with the declared selector and return ABI.
        unsafe {
            base.add_method(
                sel!(acceptanceProbe),
                probe as extern "C-unwind" fn(_, _) -> _,
            );
        }
        let base = base.register();
        let subclass = termination_subclass(c"MarquelliumTestTerminationDelegate", base).unwrap();
        assert_eq!(base.instance_size(), subclass.instance_size());
        // SAFETY: NSObject initialization, then the same no-ivar subclass
        // transition used in production. The probe is inherited unchanged.
        unsafe {
            let object: Retained<AnyObject> = msg_send![base, new];
            let previous = AnyObject::set_class(&object, subclass);
            assert!(std::ptr::eq(previous, base));
            let result: usize = msg_send![&*object, acceptanceProbe];
            assert_eq!(result, 42);
            // The callback never dereferences its sender. A nil sender models
            // a selector dispatch without initializing NSApplication in tests.
            let reply: NSApplicationTerminateReply =
                msg_send![&*object, applicationShouldTerminate: std::ptr::null::<AnyObject>()];
            assert_eq!(reply, NSApplicationTerminateReply::TerminateCancel);
        }
    }
}
