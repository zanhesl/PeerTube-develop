import { SharedModule as PrimeSharedModule } from 'primeng/api'
import { ClipboardModule } from '@angular/cdk/clipboard'
import { CommonModule, DatePipe } from '@angular/common'
import { HttpClientModule } from '@angular/common/http'
import { NgModule } from '@angular/core'
import { FormsModule, ReactiveFormsModule } from '@angular/forms'
import { RouterModule } from '@angular/router'
import {
  NgbButtonsModule,
  NgbCollapseModule,
  NgbDropdownModule,
  NgbModalModule,
  NgbNavModule,
  NgbPopoverModule,
  NgbTooltipModule
} from '@ng-bootstrap/ng-bootstrap'
import { LoadingBarModule } from '@ngx-loading-bar/core'
import { LoadingBarHttpClientModule } from '@ngx-loading-bar/http-client'
import { SharedGlobalIconModule } from '../shared-icons'
import { AccountService } from './account'
import {
  AutofocusDirective,
  BytesPipe,
  DurationFormatterPipe,
  FromNowPipe,
  InfiniteScrollerDirective,
  NumberFormatterPipe,
  PeerTubeTemplateDirective
} from './angular'
import { AUTH_INTERCEPTOR_PROVIDER } from './auth'
import { ActionDropdownComponent, ButtonComponent, DeleteButtonComponent, EditButtonComponent } from './buttons'
import { DateToggleComponent } from './date'
import { FeedComponent } from './feeds'
import { LoaderComponent, SmallLoaderComponent } from './loaders'
import { HelpComponent, ListOverflowComponent, SimpleSearchInputComponent, TopMenuDropdownComponent } from './misc'
import { UserHistoryService, UserNotificationsComponent, UserNotificationService, UserQuotaComponent } from './users'
import { RedundancyService, VideoImportService, VideoOwnershipService, VideoService } from './video'
import { VideoCaptionService } from './video-caption'
import { VideoChannelService } from './video-channel'

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    RouterModule,
    HttpClientModule,

    LoadingBarHttpClientModule,
    LoadingBarModule,

    NgbDropdownModule,
    NgbModalModule,
    NgbPopoverModule,
    NgbNavModule,
    NgbTooltipModule,
    NgbCollapseModule,
    NgbButtonsModule,

    ClipboardModule,

    PrimeSharedModule,

    SharedGlobalIconModule
  ],

  declarations: [
    FromNowPipe,
    NumberFormatterPipe,
    BytesPipe,
    DurationFormatterPipe,
    AutofocusDirective,

    InfiniteScrollerDirective,
    PeerTubeTemplateDirective,

    ActionDropdownComponent,
    ButtonComponent,
    DeleteButtonComponent,
    EditButtonComponent,

    DateToggleComponent,

    FeedComponent,

    LoaderComponent,
    SmallLoaderComponent,

    HelpComponent,
    ListOverflowComponent,
    TopMenuDropdownComponent,
    SimpleSearchInputComponent,

    UserQuotaComponent,
    UserNotificationsComponent
  ],

  exports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    RouterModule,
    HttpClientModule,

    LoadingBarHttpClientModule,
    LoadingBarModule,

    NgbDropdownModule,
    NgbModalModule,
    NgbPopoverModule,
    NgbNavModule,
    NgbTooltipModule,
    NgbCollapseModule,
    NgbButtonsModule,

    ClipboardModule,

    PrimeSharedModule,

    FromNowPipe,
    BytesPipe,
    NumberFormatterPipe,
    DurationFormatterPipe,
    AutofocusDirective,

    InfiniteScrollerDirective,
    PeerTubeTemplateDirective,

    ActionDropdownComponent,
    ButtonComponent,
    DeleteButtonComponent,
    EditButtonComponent,

    DateToggleComponent,

    FeedComponent,

    LoaderComponent,
    SmallLoaderComponent,

    HelpComponent,
    ListOverflowComponent,
    TopMenuDropdownComponent,
    SimpleSearchInputComponent,

    UserQuotaComponent,
    UserNotificationsComponent
  ],

  providers: [
    DatePipe,

    FromNowPipe,

    AUTH_INTERCEPTOR_PROVIDER,

    AccountService,

    UserHistoryService,
    UserNotificationService,

    RedundancyService,
    VideoImportService,
    VideoOwnershipService,
    VideoService,

    VideoCaptionService,

    VideoChannelService
  ]
})
export class SharedMainModule { }