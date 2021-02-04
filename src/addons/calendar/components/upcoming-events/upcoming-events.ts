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

import { Component, OnDestroy, OnInit, Input, DoCheck, Output, EventEmitter, KeyValueDiffers, KeyValueDiffer } from '@angular/core';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import { CoreSites } from '@services/sites';
import { CoreDomUtils } from '@services/utils/dom';
import {
    AddonCalendarProvider,
    AddonCalendarEventToDisplay,
    AddonCalendar,
    AddonCalendarUpdatedEventEvent,
} from '../../services/calendar';
import { AddonCalendarHelper, AddonCalendarFilter } from '../../services/calendar-helper';
import { AddonCalendarOffline } from '../../services/calendar-offline';
import { CoreCategoryData, CoreCourses } from '@features/courses/services/courses';
import { CoreConstants } from '@/core/constants';
import { CoreLocalNotifications } from '@services/local-notifications';

/**
 * Component that displays upcoming events.
 */
@Component({
    selector: 'addon-calendar-upcoming-events',
    templateUrl: 'addon-calendar-upcoming-events.html',
    styleUrls: ['../../calendar-common.scss', 'upcoming-events.scss'],
})
export class AddonCalendarUpcomingEventsComponent implements OnInit, DoCheck, OnDestroy {

    @Input() filter?: AddonCalendarFilter; // Filter to apply.
    @Output() onEventClicked = new EventEmitter<number>();

    filteredEvents: AddonCalendarEventToDisplay[] = [];
    loaded = false;

    protected year?: number;
    protected month?: number;
    protected categoriesRetrieved = false;
    protected categories: { [id: number]: CoreCategoryData } = {};
    protected currentSiteId: string;
    protected events: AddonCalendarEventToDisplay[] = []; // Events (both online and offline).
    protected onlineEvents: AddonCalendarEventToDisplay[] = [];
    protected offlineEvents: AddonCalendarEventToDisplay[] = []; // Offline events.
    protected deletedEvents: number[] = []; // Events deleted in offline.
    protected lookAhead = 0;
    protected timeFormat?: string;
    protected differ: KeyValueDiffer<unknown, unknown>; // To detect changes in the data input.

    // Observers.
    protected undeleteEventObserver: CoreEventObserver;
    protected obsDefaultTimeChange?: CoreEventObserver;

    constructor(
        differs: KeyValueDiffers,
    ) {
        this.currentSiteId = CoreSites.instance.getCurrentSiteId();

        if (CoreLocalNotifications.instance.isAvailable()) {            // Re-schedule events if default time changes.
            this.obsDefaultTimeChange = CoreEvents.on(AddonCalendarProvider.DEFAULT_NOTIFICATION_TIME_CHANGED, () => {
                AddonCalendar.instance.scheduleEventsNotifications(this.onlineEvents);
            }, this.currentSiteId);
        }

        // Listen for events "undeleted" (offline).
        this.undeleteEventObserver = CoreEvents.on(
            AddonCalendarProvider.UNDELETED_EVENT_EVENT,
            (data: AddonCalendarUpdatedEventEvent) => {
                if (!data || !data.eventId) {
                    return;
                }

                // Mark it as undeleted, no need to refresh.
                this.undeleteEvent(data.eventId);

                // Remove it from the list of deleted events if it's there.
                const index = this.deletedEvents.indexOf(data.eventId);
                if (index != -1) {
                    this.deletedEvents.splice(index, 1);
                }
            },
            this.currentSiteId,
        );

        this.differ = differs.find([]).create();
    }

    /**
     * Component loaded.
     */
    ngOnInit(): void {
        this.fetchData();
    }

    /**
     * Detect and act upon changes that Angular can’t or won’t detect on its own (objects and arrays).
     */
    ngDoCheck(): void {
        // Check if there's any change in the filter object.
        const changes = this.differ.diff(this.filter!);
        if (changes) {
            this.filterEvents();
        }
    }

    /**
     * Fetch data.
     *
     * @return Promise resolved when done.
     */
    async fetchData(): Promise<void> {
        const promises: Promise<void>[] = [];

        promises.push(this.loadCategories());

        // Get offline events.
        promises.push(AddonCalendarOffline.instance.getAllEditedEvents().then((offlineEvents) => {
            // Format data.
            const events: AddonCalendarEventToDisplay[] = offlineEvents.map((event) =>
                AddonCalendarHelper.instance.formatOfflineEventData(event));

            this.offlineEvents = AddonCalendarHelper.instance.sortEvents(events);

            return;
        }));

        // Get events deleted in offline.
        promises.push(AddonCalendarOffline.instance.getAllDeletedEventsIds().then((ids) => {
            this.deletedEvents = ids;

            return;
        }));

        // Get user preferences.
        promises.push(AddonCalendar.instance.getCalendarLookAhead().then((value) => {
            this.lookAhead = value;

            return;
        }));

        promises.push(AddonCalendar.instance.getCalendarTimeFormat().then((value) => {
            this.timeFormat = value;

            return;
        }));

        try {
            await Promise.all(promises);

            this.fetchEvents();

        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'addon.calendar.errorloadevents', true);
        }

        this.loaded = true;
    }

    /**
     * Fetch upcoming events.
     *
     * @return Promise resolved when done.
     */
    async fetchEvents(): Promise<void> {
        // Don't pass courseId and categoryId, we'll filter them locally.
        const result = await AddonCalendar.instance.getUpcomingEvents();
        this.onlineEvents = result.events.map((event) => AddonCalendarHelper.instance.formatEventData(event));
        // Schedule notifications for the events retrieved.
        AddonCalendar.instance.scheduleEventsNotifications(this.onlineEvents);
        // Merge the online events with offline data.
        this.events = this.mergeEvents();
        // Filter events by course.
        this.filterEvents();

        // Re-calculate the formatted time so it uses the device date.
        const promises = this.events.map((event) =>
            AddonCalendar.instance.formatEventTime(event, this.timeFormat!).then((time) => {
                event.formattedtime = time;

                return;
            }));

        await Promise.all(promises);
    }

    /**
     * Load categories to be able to filter events.
     *
     * @return Promise resolved when done.
     */
    protected async loadCategories(): Promise<void> {
        if (this.categoriesRetrieved) {
            // Already retrieved, stop.
            return;
        }

        try {
            const cats = await CoreCourses.instance.getCategories(0, true);
            this.categoriesRetrieved = true;
            this.categories = {};

            // Index categories by ID.
            cats.forEach((category) => {
                this.categories[category.id] = category;
            });
        } catch {
            // Ignore errors.
        }
    }

    /**
     * Filter events based on the filter popover.
     */
    protected filterEvents(): void {
        this.filteredEvents = AddonCalendarHelper.instance.getFilteredEvents(this.events, this.filter!, this.categories);
    }

    /**
     * Refresh events.
     *
     * @param afterChange Whether the refresh is done after an event has changed or has been synced.
     * @return Promise resolved when done.
     */
    async refreshData(afterChange?: boolean): Promise<void> {
        const promises: Promise<void>[] = [];

        // Don't invalidate upcoming events after a change, it has already been handled.
        if (!afterChange) {
            promises.push(AddonCalendar.instance.invalidateAllUpcomingEvents());
        }
        promises.push(CoreCourses.instance.invalidateCategories(0, true));
        promises.push(AddonCalendar.instance.invalidateLookAhead());
        promises.push(AddonCalendar.instance.invalidateTimeFormat());

        this.categoriesRetrieved = false; // Get categories again.

        await Promise.all(promises);

        await this.fetchData();
    }

    /**
     * An event was clicked.
     *
     * @param event Event.
     */
    eventClicked(event: AddonCalendarEventToDisplay): void {
        this.onEventClicked.emit(event.id);
    }

    /**
     * Merge online events with the offline events of that period.
     *
     * @return Merged events.
     */
    protected mergeEvents(): AddonCalendarEventToDisplay[] {
        if (!this.offlineEvents.length && !this.deletedEvents.length) {
            // No offline events, nothing to merge.
            return this.onlineEvents;
        }

        const start = Date.now() / 1000;
        const end = start + (CoreConstants.SECONDS_DAY * this.lookAhead);
        let result: AddonCalendarEventToDisplay[] = this.onlineEvents;

        if (this.deletedEvents.length) {
            // Mark as deleted the events that were deleted in offline.
            result.forEach((event) => {
                event.deleted = this.deletedEvents.indexOf(event.id) != -1;
            });
        }

        if (this.offlineEvents.length) {
            // Remove the online events that were modified in offline.
            result = result.filter((event) => {
                const offlineEvent = this.offlineEvents.find((ev) => ev.id == event.id);

                return !offlineEvent;
            });
        }

        // Now get the offline events that belong to this period.
        const periodOfflineEvents =
            this.offlineEvents.filter((event) =>
                (event.timestart >= start || event.timestart + event.timeduration >= start) && event.timestart <= end);

        // Merge both arrays and sort them.
        result = result.concat(periodOfflineEvents);

        return AddonCalendarHelper.instance.sortEvents(result);
    }

    /**
     * Undelete a certain event.
     *
     * @param eventId Event ID.
     */
    protected undeleteEvent(eventId: number): void {
        const event = this.onlineEvents.find((event) => event.id == eventId);

        if (event) {
            event.deleted = false;
        }
    }

    /**
     * Component destroyed.
     */
    ngOnDestroy(): void {
        this.undeleteEventObserver?.off();
        this.obsDefaultTimeChange?.off();
    }

}