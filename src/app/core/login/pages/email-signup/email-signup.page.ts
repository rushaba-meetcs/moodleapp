// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, ViewChild, ElementRef, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { NavController, IonContent, IonRefresher } from '@ionic/angular';

import { CoreSites } from '@services/sites';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreTextUtils } from '@services/utils/text';
import { CoreCountry, CoreUtils } from '@services/utils/utils';
import { CoreWS, CoreWSExternalWarning } from '@services/ws';
import { AuthEmailSignupProfileFieldsCategory, AuthEmailSignupSettings, CoreLoginHelper } from '@core/login/services/login.helper';
import { CoreConstants } from '@core/constants';
import { Translate } from '@singletons/core.singletons';
import { CoreSitePublicConfigResponse } from '@classes/site';

/**
 * Page to signup using email.
 */
@Component({
    selector: 'page-core-login-email-signup',
    templateUrl: 'email-signup.html',
    styleUrls: ['../../login.scss'],
})
export class CoreLoginEmailSignupPage implements OnInit {

    @ViewChild(IonContent) content?: IonContent;
    @ViewChild('ageForm') ageFormElement?: ElementRef;
    @ViewChild('signupFormEl') signupFormElement?: ElementRef;

    signupForm: FormGroup;
    siteUrl!: string;
    siteConfig?: CoreSitePublicConfigResponse;
    siteName?: string;
    authInstructions?: string;
    settings?: AuthEmailSignupSettings;
    countries?: CoreCountry[];
    categories?: AuthEmailSignupProfileFieldsCategory[];
    settingsLoaded = false;
    allRequiredSupported = true;
    signupUrl?: string;
    captcha = {
        recaptcharesponse: '',
    };

    // Data for age verification.
    ageVerificationForm: FormGroup;
    countryControl: FormControl;
    signUpCountryControl?: FormControl;
    isMinor = false; // Whether the user is minor age.
    ageDigitalConsentVerification?: boolean; // Whether the age verification is enabled.
    supportName?: string;
    supportEmail?: string;

    // Validation errors.
    usernameErrors: Record<string, string>;
    passwordErrors: Record<string, string>;
    emailErrors: Record<string, string>;
    email2Errors: Record<string, string>;
    policyErrors: Record<string, string>;
    namefieldsErrors?: Record<string, Record<string, string>>;

    constructor(
        protected navCtrl: NavController,
        protected fb: FormBuilder,
        protected route: ActivatedRoute,
    ) {
        // Create the ageVerificationForm.
        this.ageVerificationForm = this.fb.group({
            age: ['', Validators.required],
        });
        this.countryControl = this.fb.control('', Validators.required);
        this.ageVerificationForm.addControl('country', this.countryControl);

        // Create the signupForm with the basic controls. More controls will be added later.
        this.signupForm = this.fb.group({
            username: ['', Validators.required],
            password: ['', Validators.required],
            email: ['', Validators.compose([Validators.required, Validators.email])],
            email2: ['', Validators.compose([Validators.required, Validators.email])],
        });

        // Setup validation errors.
        this.usernameErrors = CoreLoginHelper.instance.getErrorMessages('core.login.usernamerequired');
        this.passwordErrors = CoreLoginHelper.instance.getErrorMessages('core.login.passwordrequired');
        this.emailErrors = CoreLoginHelper.instance.getErrorMessages('core.login.missingemail');
        this.policyErrors = CoreLoginHelper.instance.getErrorMessages('core.login.policyagree');
        this.email2Errors = CoreLoginHelper.instance.getErrorMessages(
            'core.login.missingemail',
            undefined,
            'core.login.emailnotmatch',
        );
    }

    /**
     * Component initialized.
     */
    ngOnInit(): void {
        this.siteUrl = this.route.snapshot.queryParams['siteUrl'];

        // Fetch the data.
        this.fetchData().finally(() => {
            this.settingsLoaded = true;
        });
    }

    /**
     * Complete the FormGroup using the settings received from server.
     */
    protected completeFormGroup(): void {
        this.signupForm.addControl('city', this.fb.control(this.settings?.defaultcity || ''));
        this.signUpCountryControl = this.fb.control(this.settings?.country || '');
        this.signupForm.addControl('country', this.signUpCountryControl);

        // Add the name fields.
        for (const i in this.settings?.namefields) {
            this.signupForm.addControl(this.settings?.namefields[i], this.fb.control('', Validators.required));
        }

        if (this.settings?.sitepolicy) {
            this.signupForm.addControl('policyagreed', this.fb.control(false, Validators.requiredTrue));
        }
    }

    /**
     * Fetch the required data from the server.
     *
     * @return Promise resolved when done.
     */
    protected async fetchData(): Promise<void> {
        try {
            // Get site config.
            this.siteConfig = await CoreSites.instance.getSitePublicConfig(this.siteUrl);
            this.signupUrl = CoreTextUtils.instance.concatenatePaths(this.siteConfig.httpswwwroot, 'login/signup.php');

            if (this.treatSiteConfig()) {
                // Check content verification.
                if (typeof this.ageDigitalConsentVerification == 'undefined') {

                    const result = await CoreUtils.instance.ignoreErrors(
                        CoreWS.instance.callAjax<IsAgeVerificationEnabledResponse>(
                            'core_auth_is_age_digital_consent_verification_enabled',
                            {},
                            { siteUrl: this.siteUrl },
                        ),
                    );

                    this.ageDigitalConsentVerification = !!result?.status;
                }

                await this.getSignupSettings();
            }

            this.completeFormGroup();
        } catch (error) {
            if (this.allRequiredSupported) {
                CoreDomUtils.instance.showErrorModal(error);
            }
        }
    }

    /**
     * Get signup settings from server.
     *
     * @return Promise resolved when done.
     */
    protected async getSignupSettings(): Promise<void> {
        this.settings = await CoreWS.instance.callAjax<AuthEmailSignupSettings>(
            'auth_email_get_signup_settings',
            {},
            { siteUrl: this.siteUrl },
        );

        // @todo userProfileFieldDelegate

        this.categories = CoreLoginHelper.instance.formatProfileFieldsForSignup(this.settings.profilefields);

        if (this.settings.recaptchapublickey) {
            this.captcha.recaptcharesponse = ''; // Reset captcha.
        }

        if (!this.countryControl.value) {
            this.countryControl.setValue(this.settings.country || '');
        }

        this.namefieldsErrors = {};
        if (this.settings.namefields) {
            this.settings.namefields.forEach((field) => {
                this.namefieldsErrors![field] = CoreLoginHelper.instance.getErrorMessages('core.login.missing' + field);
            });
        }

        this.countries = await CoreUtils.instance.getCountryListSorted();
    }

    /**
     * Treat the site config, checking if it's valid and extracting the data we're interested in.
     *
     * @return True if success.
     */
    protected treatSiteConfig(): boolean {
        if (this.siteConfig?.registerauth == 'email' && !CoreLoginHelper.instance.isEmailSignupDisabled(this.siteConfig)) {
            this.siteName = CoreConstants.CONFIG.sitename ? CoreConstants.CONFIG.sitename : this.siteConfig.sitename;
            this.authInstructions = this.siteConfig.authinstructions;
            this.ageDigitalConsentVerification = this.siteConfig.agedigitalconsentverification;
            this.supportName = this.siteConfig.supportname;
            this.supportEmail = this.siteConfig.supportemail;
            this.countryControl.setValue(this.siteConfig.country || '');

            return true;
        } else {
            CoreDomUtils.instance.showErrorModal(
                Translate.instance.instant(
                    'core.login.signupplugindisabled',
                    { $a: Translate.instance.instant('core.login.auth_email') },
                ),
            );
            this.navCtrl.pop();

            return false;
        }
    }

    /**
     * Pull to refresh.
     *
     * @param event Event.
     */
    refreshSettings(event?: CustomEvent<IonRefresher>): void {
        this.fetchData().finally(() => {
            event?.detail.complete();
        });
    }

    /**
     * Create account.
     *
     * @param e Event.
     * @return Promise resolved when done.
     */
    async create(e: Event): Promise<void> {
        e.preventDefault();
        e.stopPropagation();

        if (!this.signupForm.valid || (this.settings?.recaptchapublickey && !this.captcha.recaptcharesponse)) {
            // Form not valid. Scroll to the first element with errors.
            const errorFound = await CoreDomUtils.instance.scrollToInputError(this.content);

            if (!errorFound) {
                // Input not found, show an error modal.
                CoreDomUtils.instance.showErrorModal('core.errorinvalidform', true);
            }

            return;
        }

        const modal = await CoreDomUtils.instance.showModalLoading('core.sending', true);

        const params: Record<string, unknown> = {
            username: this.signupForm.value.username.trim().toLowerCase(),
            password: this.signupForm.value.password,
            firstname: CoreTextUtils.instance.cleanTags(this.signupForm.value.firstname),
            lastname: CoreTextUtils.instance.cleanTags(this.signupForm.value.lastname),
            email: this.signupForm.value.email.trim(),
            city: CoreTextUtils.instance.cleanTags(this.signupForm.value.city),
            country: this.signupForm.value.country,
        };

        if (this.siteConfig?.launchurl) {
            const service = CoreSites.instance.determineService(this.siteUrl);
            params.redirect = CoreLoginHelper.instance.prepareForSSOLogin(this.siteUrl, service, this.siteConfig.launchurl);
        }

        // Get the recaptcha response (if needed).
        if (this.settings?.recaptchapublickey && this.captcha.recaptcharesponse) {
            params.recaptcharesponse = this.captcha.recaptcharesponse;
        }

        try {
            // @todo Get the data for the custom profile fields.
            const result = await CoreWS.instance.callAjax<SignupUserResult>(
                'auth_email_signup_user',
                params,
                { siteUrl: this.siteUrl },
            );

            if (result.success) {

                CoreDomUtils.instance.triggerFormSubmittedEvent(this.signupFormElement, true);

                // Show alert and ho back.
                const message = Translate.instance.instant('core.login.emailconfirmsent', { $a: params.email });
                CoreDomUtils.instance.showAlert(Translate.instance.instant('core.success'), message);
                this.navCtrl.pop();
            } else {
                if (result.warnings && result.warnings.length) {
                    let error = result.warnings[0].message;
                    if (error == 'incorrect-captcha-sol') {
                        error = Translate.instance.instant('core.login.recaptchaincorrect');
                    }

                    CoreDomUtils.instance.showErrorModal(error);
                } else {
                    CoreDomUtils.instance.showErrorModal('core.login.usernotaddederror', true);
                }
            }
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'core.login.usernotaddederror', true);
        } finally {
            modal.dismiss();
        }
    }

    /**
     * Escape mail to avoid special characters to be treated as a RegExp.
     *
     * @param text Initial mail.
     * @return Escaped mail.
     */
    escapeMail(text: string): string {
        return CoreTextUtils.instance.escapeForRegex(text);
    }

    /**
     * Show authentication instructions.
     */
    showAuthInstructions(): void {
        CoreTextUtils.instance.viewText(Translate.instance.instant('core.login.instructions'), this.authInstructions!);
    }

    /**
     * Show contact information on site (we have to display again the age verification form).
     */
    showContactOnSite(): void {
        CoreUtils.instance.openInBrowser(CoreTextUtils.instance.concatenatePaths(this.siteUrl, '/login/verify_age_location.php'));
    }

    /**
     * Verify Age.
     *
     * @param e Event.
     * @return Promise resolved when done.
     */
    async verifyAge(e: Event): Promise<void> {
        e.preventDefault();
        e.stopPropagation();

        if (!this.ageVerificationForm.valid) {
            CoreDomUtils.instance.showErrorModal('core.errorinvalidform', true);

            return;
        }

        const modal = await CoreDomUtils.instance.showModalLoading('core.sending', true);

        const params = this.ageVerificationForm.value;

        params.age = parseInt(params.age, 10); // Use just the integer part.

        try {
            const result = await CoreWS.instance.callAjax<IsMinorResult>('core_auth_is_minor', params, { siteUrl: this.siteUrl });

            CoreDomUtils.instance.triggerFormSubmittedEvent(this.ageFormElement, true);

            if (!result.status) {
                if (this.countryControl.value) {
                    this.signUpCountryControl!.setValue(this.countryControl.value);
                }

                // Not a minor, go ahead.
                this.ageDigitalConsentVerification = false;
            } else {
                // Is a minor.
                this.isMinor = true;
            }
        } catch (error) {
            // Something wrong, redirect to the site.
            CoreDomUtils.instance.showErrorModal('There was an error verifying your age, please try again using the browser.');
        } finally {
            modal.dismiss();
        }
    }

}

/**
 * Result of WS core_auth_is_age_digital_consent_verification_enabled.
 */
export type IsAgeVerificationEnabledResponse = {
    status: boolean; // True if digital consent verification is enabled, false otherwise.
};

/**
 * Result of WS auth_email_signup_user.
 */
export type SignupUserResult = {
    success: boolean; // True if the user was created false otherwise.
    warnings?: CoreWSExternalWarning[];
};

/**
 * Result of WS core_auth_is_minor.
 */
export type IsMinorResult = {
    status: boolean; // True if the user is considered to be a digital minor, false if not.
};